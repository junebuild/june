---
name: bulk_reorder
description: Reorder many items at once from a supplier list, checking stock first.
---

1. Read the supplier list.
2. For each item, check stock with lookup_inventory.
3. Place an order for anything below its threshold.
