export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Outbound email port. A real provider adapter (SES, Resend, ...) implements this in the notifications milestone. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Collects messages in memory. Used by tests. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastTo(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

/** Prints messages (including one-time links) to the console. Development only; refused in production. */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.log(`\n[dev mail] to=${message.to}\nsubject: ${message.subject}\n${message.text}\n`);
  }
}

/**
 * Appends each message as a JSON line to a file. For end-to-end tests, which read one-time links back from it.
 * Development and test only; like the console mailer, it must never run in production.
 */
export class FileMailer implements Mailer {
  constructor(private readonly path: string) {}
  async send(message: MailMessage): Promise<void> {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.path, `${JSON.stringify(message)}\n`, "utf8");
  }
}

/** Sends without letting a mail failure break the request; the failure is logged. */
export async function trySend(
  mailer: Mailer,
  message: MailMessage,
  log: { error: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    await mailer.send(message);
  } catch (err) {
    log.error({ err, to: "redacted" }, "failed to send email");
  }
}
