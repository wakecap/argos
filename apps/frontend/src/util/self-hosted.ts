import type { ClientConfig } from "@argos/config-types";

import { config } from "@/config";

/**
 * A self-hosted install (`SELF_HOSTED`): billing, plans, upsells and Argos's
 * own community and sales links are hidden.
 */
export const isSelfHosted = config.selfHosted.enabled;

type OptionalService = keyof ClientConfig["selfHosted"]["configured"];

/**
 * Whether to offer an optional sign-in option or integration: always on
 * Argos's own install, and on a self-hosted one only when it is configured.
 */
export function checkIsServiceOffered(service: OptionalService): boolean {
  return !isSelfHosted || config.selfHosted.configured[service];
}
