import { CartBadge } from "./CartBadge";
import { AddToCart } from "./AddToCart";

// CartBadge and the AddToCart buttons are SEPARATE islands (separate React roots).
// They stay in sync only because both import the same cartStore — the cross-island
// store. Clicking an Add button updates the badge.
export default function CartPage() {
  return (
    <main>
      <h1>Cart</h1>
      <p>
        Badge: <CartBadge client:load />
      </p>
      <AddToCart id="apple" client:load />
      <AddToCart id="pear" client:load />
    </main>
  );
}

export const metadata = { title: "Cart" };
