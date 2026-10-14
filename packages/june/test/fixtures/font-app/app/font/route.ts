// On workerd a Data module: the font file's bytes.
import font from "../../../../../assets/icon-latin.ttf";

export default function fontRoute(): Response {
  return new Response(new Uint8Array(font), { headers: { "content-type": "font/ttf" } });
}
