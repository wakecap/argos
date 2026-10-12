/**
 * Client config types shared between frontend and backend.
 */
export interface ClientConfig {
  sentry: {
    environment: string;
    clientDsn: string;
  };
  session: {
    domain: string;
  };
  samlTeamSlug: string;
  releaseVersion: string;
  contactEmail: string;
  github: {
    appUrl: string;
    clientId: string;
    loginUrl: string;
    marketplaceUrl: string;
  };
  githubLight: {
    appUrl: string;
  };
  gitlab: {
    loginUrl: string;
  };
  stripe: {
    pricingTableId: string;
    publishableKey: string;
  };
  server: {
    url: string;
  };
  api: {
    baseUrl: string;
  };
  deployments: {
    baseDomain: string;
    /** Whether this install can provision custom domains at all. */
    customDomains: boolean;
  };
  /**
   * A self-hosted install hides billing, plans, upsells and Argos's community
   * links, and offers only the optional services it has configured.
   */
  selfHosted: {
    enabled: boolean;
    configured: {
      google: boolean;
      gitlab: boolean;
      slack: boolean;
      githubLight: boolean;
    };
  };
}
