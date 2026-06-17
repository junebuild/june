import type { RouteContext, Loaded } from "@junejs/core/route";
// The TYPED t, generated from messages/*.json by `june gen` (app/_messages.ts).
// Importing it also registers the compiled catalogs (defineMessages side effect).
// `t` is ambient — it reads ctx.locale off the request scope, no threading.
import { t } from "../_messages";

export const loader = (ctx: RouteContext) => ({ locale: ctx.locale });

export default function Greet({ locale }: Loaded<typeof loader>) {
  return (
    <main>
      <p data-locale={locale}>{t("greeting", { name: "Ada" })}</p>
      <p>{t("items", { n: 3 })}</p>
    </main>
  );
}
