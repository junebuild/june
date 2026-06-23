"use client";
import { useStore } from "@junejs/core/store";
import { cartStore } from "./cart-store";

export function AddToCart({ id }: { id: string }) {
  const [, setCart] = useStore(cartStore);
  return (
    <button type="button" onClick={() => setCart((c) => [...c, id])}>
      Add {id}
    </button>
  );
}
