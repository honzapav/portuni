// displayError(): the text a component shows for a caught error, in the
// current UI language. Binds lib/api-error.ts's errorText to the app's i18n
// instance; `errors` is a boot namespace, so it is always loaded.

import { i18n } from "./i18n";
import { errorText } from "./lib/api-error";

export function displayError(err: unknown): string {
  return errorText(err, i18n.getFixedT(null, "errors"));
}
