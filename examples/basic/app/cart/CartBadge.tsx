"use client";
import { useStore } from "@junejs/core/store";
import { cartStore } from "./cart-store";

// A separate island from AddToCart — they share state only through cartStore.
export function CartBadge() {
  const [items] = useStore(cartStore, (c) => c.length);
  return <strong data-cart-count>cart: {items}</strong>;
}
