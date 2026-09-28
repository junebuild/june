// /contact — authored once, as content/pages/contact.md (see ContentPage.tsx).
import { contentRoute } from "../ContentPage";

const route = contentRoute("contact", "Get in touch");

export const prerender = true;
export default route.View;
export const metadata = route.metadata;
export const md = route.md;
export const json = route.json;
