// /about — authored once, as content/pages/about.md (see ContentPage.tsx).
import { contentRoute } from "../ContentPage";

const route = contentRoute("about", "The project");

export const prerender = true;
export default route.View;
export const metadata = route.metadata;
export const md = route.md;
export const json = route.json;
