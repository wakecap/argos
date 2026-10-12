import { render } from "react-email";
import { Resend } from "resend";

import config from "@/config";
import logger from "@/logger";

const production = config.get("env") === "production";
const resendApiKey = config.get("resend.apiKey");

// Resend throws if API key is missing. Without one, emails are not sent: in
// production that is logged on every send, so a self-hosted instance can run
// before email is set up.
const resend = resendApiKey ? new Resend(resendApiKey) : null;

const defaultFrom = "Argos <contact@argos-ci.com>";

/**
 * Send an email using Resend.
 */
export async function sendEmail(options: {
  /**
   * Email address to send to.
   */
  to: string[];
  /**
   * Email subject.
   */
  subject: string;
  /**
   * Email body as React element.
   */
  react: React.ReactElement;
}) {
  if (production) {
    if (!resend) {
      logger.error("Resend API key is missing");
      return null;
    }
  } else if (!resend) {
    return null;
  }
  const text = await render(options.react, { plainText: true });
  return resend.emails.send({ ...options, text, from: defaultFrom });
}
