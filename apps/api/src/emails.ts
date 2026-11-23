import type { AppConfig } from "./config";
import type { MailMessage } from "./mailer";

export function verificationEmail(config: AppConfig, to: string, token: string): MailMessage {
  const link = `${config.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: `Verify your email for ${config.brandName}`,
    text: `Welcome to ${config.brandName}.\n\nConfirm your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you did not create an account, you can ignore this message.`,
  };
}

export function passwordResetEmail(config: AppConfig, to: string, token: string): MailMessage {
  const link = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: `Reset your ${config.brandName} password`,
    text: `We received a request to reset your password.\n\nChoose a new password using this link (valid for 1 hour):\n${link}\n\nIf you did not ask for this, ignore this message; your password has not changed.`,
  };
}
