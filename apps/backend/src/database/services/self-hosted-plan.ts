import { Plan } from "../models/Plan";

const SELF_HOSTED_PLAN_NAME = "self-hosted";

/**
 * The plan a team gets on an install with no Stripe account (self-hosted):
 * no checkout, no trial, no screenshot quota. Created on first use.
 *
 * Not usage-based on purpose: a usage-based plan without a subscription fails
 * the overage check in the build job.
 */
export async function getSelfHostedPlan(): Promise<Plan> {
  const existing = await Plan.query().findOne({ name: SELF_HOSTED_PLAN_NAME });
  if (existing) {
    return existing;
  }
  return Plan.query().insertAndFetch({
    name: SELF_HOSTED_PLAN_NAME,
    // The column is a 32-bit integer.
    includedScreenshots: 2_000_000_000,
    usageBased: false,
    interval: "month",
    githubPlanId: null,
    stripeProductId: null,
    githubSsoIncluded: true,
    fineGrainedAccessControlIncluded: true,
    samlIncluded: false,
    customDomainsIncluded: false,
    staticIpIncluded: false,
  });
}
