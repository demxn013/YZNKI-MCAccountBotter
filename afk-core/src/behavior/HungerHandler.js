"use strict";

/**
 * HungerHandler
 *
 * Tracks the player's food level via minecraft-protocol packets and
 * automatically eats food from the hotbar or offhand when hungry.
 *
 * Trigger: food level drops below EAT_THRESHOLD (18 = 1 full bar lost).
 * Source:  hotbar slots (36-44 in windowId 0) and offhand (slot 45).
 *
 * Compatible with all supported server profiles (1.9+).
 * 1.8.x eating is intentionally skipped (different packet format).
 */

// Safe food items to auto-eat (dangerous items excluded).
// Names match minecraft-data item names for all supported versions.
const FOOD_ITEM_NAMES = [
  // Cooked meats — highest saturation, preferred
  "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
  "cooked_rabbit", "cooked_cod", "cooked_salmon",
  // Raw meats
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
  // Bread & baked goods
  "bread", "cookie", "pumpkin_pie",
  // Fruits & vegetables
  "apple", "golden_apple", "enchanted_golden_apple",
  "carrot", "golden_carrot", "melon_slice",
  "baked_potato", "potato", "beetroot",
  "sweet_berries", "glow_berries",
  // Fish & seafood
  "tropical_fish", "dried_kelp",
  // Misc
  "honey_bottle",
  // Stews (non-stackable but valid)
  "mushroom_stew", "beetroot_soup", "rabbit_stew",
  // Other
  "chorus_fruit",
];

// Start eating once food drops below this value.
// 18 = 1 full bar lost (each bar = 2 food points).
const EAT_THRESHOLD = 18;

// Minimum ms between eat attempts to avoid spamming.
const EAT_COOLDOWN_MS = 2000;

// Delay (ms) after switching hotbar slot before sending use_item.
// Gives the server time to acknowledge the slot change.
const SLOT_SWITCH_DELAY_MS = 150;

class HungerHandler {
  /**
   * @param {string} version - Minecraft version string, e.g. "1.21.4"
   */
  constructor(version) {
    this.version = version;

    // Parsed minor version for compatibility checks.
    const parts = String(version || "1.21.4").split(".");
    this._minor = parseInt(parts[1] || "0", 10);

    this.foodLevel = 20;
    this.saturation = 5.0;
    this.isEating = false;
    this.eatCooldown = 0;
    this.currentHeldSlot = 0;

    // Player inventory slot cache (46 slots for windowId 0):
    //   0        = crafting output
    //   1-4      = crafting grid
    //   5-8      = armor
    //   9-35     = main inventory
    //   36-44    = hotbar  (hotbar slot N = inventory index 36 + N)
    //   45       = offhand
    this._inventory = new Array(46).fill(null);

    // Map of itemId (number) → item name (string) for food items only.
    this._foodIds = new Map();
    this._buildFoodIds(version);
  }

  /**
   * Build the food item ID set for the given game version using minecraft-data.
   * minecraft-data is a transitive dependency of minecraft-protocol and is
   * always available in the afk-core environment.
   * @private
   */
  _buildFoodIds(version) {
    try {
      const mcData = require("minecraft-data")(version);
      if (!mcData || !mcData.itemsByName) return;

      for (const name of FOOD_ITEM_NAMES) {
        const item = mcData.itemsByName[name];
        if (item && item.id != null) {
          this._foodIds.set(item.id, name);
        }
      }

      console.log(
        `[HungerHandler] ✅ Loaded ${this._foodIds.size} food item IDs for v${version}`
      );
    } catch (err) {
      console.warn(
        `[HungerHandler] ⚠️ Could not load minecraft-data for v${version}:`,
        err.message
      );
    }
  }

  /**
   * Attach all necessary packet listeners to the minecraft-protocol client.
   * Call this once from the profile's attachHandlers() method.
   * @param {object} client - minecraft-protocol client instance
   */
  attach(client) {
    // Track food level changes.
    client.on("update_health", (packet) => {
      const prevFood = this.foodLevel;
      this.foodLevel = Math.floor(packet.food || 0);
      this.saturation = packet.foodSaturation || 0;

      // React immediately when food drops below threshold.
      if (this.foodLevel < prevFood && this.foodLevel < EAT_THRESHOLD) {
        this._tryEat(client);
      }
    });

    // Full inventory sync (sent when a container opens, or on first login).
    client.on("window_items", (packet) => {
      if (packet.windowId !== 0) return;

      // minecraft-protocol uses "items" in 1.17+, "slotData" in older versions.
      const items = packet.items || packet.slotData || [];
      for (let i = 0; i < Math.min(items.length, this._inventory.length); i++) {
        this._inventory[i] = items[i];
      }
    });

    // Single slot updates (item picked up, placed, crafted, etc.).
    client.on("set_slot", (packet) => {
      // windowId -2 means "update player inventory regardless of open window".
      const wid = packet.windowId;
      if (wid !== 0 && wid !== -2) return;
      if (packet.slot >= 0 && packet.slot < this._inventory.length) {
        this._inventory[packet.slot] = packet.item;
      }
    });

    // Track when the server confirms our held slot change.
    client.on("held_item_slot", (packet) => {
      if (packet.slot != null) this.currentHeldSlot = packet.slot;
    });
  }

  /**
   * Optional periodic check — call from a profile's tick() method.
   * The reactive update_health listener handles most cases; this is a
   * safety net for cases where food drains without a health update.
   * @param {object} client
   */
  tick(client) {
    if (
      !this.isEating &&
      Date.now() >= this.eatCooldown &&
      this.foodLevel < EAT_THRESHOLD
    ) {
      this._tryEat(client);
    }
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Returns true if the given slot item is an edible food item.
   * @private
   */
  _isFood(slot) {
    if (!slot || !slot.present) return false;
    return this._foodIds.has(slot.itemId);
  }

  /**
   * Scan the hotbar (inventory indices 36-44) for food.
   * Returns the hotbar slot number (0-8) or -1.
   * @private
   */
  _findFoodInHotbar() {
    for (let i = 0; i <= 8; i++) {
      if (this._isFood(this._inventory[36 + i])) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Returns true if the offhand slot (inventory index 45) has food.
   * @private
   */
  _offhandHasFood() {
    return this._isFood(this._inventory[45]);
  }

  /**
   * Main eating logic. Finds food and triggers eating if eligible.
   * @param {object} client
   * @private
   */
  _tryEat(client) {
    if (this.isEating || Date.now() < this.eatCooldown) return;
    if (this.foodLevel >= EAT_THRESHOLD) return;
    if (this._foodIds.size === 0) return; // No food data available
    if (this._minor <= 8) return; // 1.8.x uses a different packet format

    // Offhand: no slot switch needed, eat immediately.
    if (this._offhandHasFood()) {
      this._doEat(client, 1 /* offhand */);
      return;
    }

    // Hotbar: may need to switch slots first.
    const hotbarSlot = this._findFoodInHotbar();
    if (hotbarSlot === -1) return; // No food in hotbar or offhand

    if (this.currentHeldSlot !== hotbarSlot) {
      try {
        client.write("held_item_slot", { slotId: hotbarSlot });
        this.currentHeldSlot = hotbarSlot;
      } catch {
        return;
      }
      // Brief delay to let the server acknowledge the slot switch.
      setTimeout(() => this._doEat(client, 0 /* main hand */), SLOT_SWITCH_DELAY_MS);
    } else {
      this._doEat(client, 0 /* main hand */);
    }
  }

  /**
   * Send the use_item packet to begin eating.
   *
   * Packet format history:
   *   ≤ 1.8  : block_place / different system  → handled by _minor check above
   *   1.9-1.19.3 : { hand }
   *   1.19.4+    : { hand, sequence }
   *   1.21.2+    : { hand, sequence, yaw, pitch }  (additional fields for interaction)
   *
   * We send the most complete format; extra fields are silently ignored
   * by older-version protocol serializers.
   *
   * @param {object} client
   * @param {number} hand - 0 = main hand, 1 = offhand
   * @private
   */
  _doEat(client, hand) {
    if (this.isEating) return;
    this.isEating = true;

    try {
      // Most complete format (1.21.2+); extra fields ignored on older versions.
      client.write("use_item", { hand, sequence: 0, yaw: 0.0, pitch: 0.0 });
    } catch {
      // Fallback for versions that don't have yaw/pitch.
      try {
        client.write("use_item", { hand, sequence: 0 });
      } catch {
        // Final fallback for pre-1.19.4.
        try {
          client.write("use_item", { hand });
        } catch {
          // All attempts failed — not critical.
        }
      }
    }

    // Eating takes ~1.61 s in Minecraft; reset state after 2 s with cooldown.
    setTimeout(() => {
      this.isEating = false;
      this.eatCooldown = Date.now() + EAT_COOLDOWN_MS;
    }, 2000);
  }
}

module.exports = { HungerHandler };