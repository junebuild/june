---
name: bulk_reorder
description: Reorder many items at once from a supplier list, checking stock first.
when-to-use: The user pastes a supplier list or asks to restock more than one item.
---

1. Read the supplier list.
2. For each item, check stock with lookup_inventory.
3. Place an order for anything below its threshold.
