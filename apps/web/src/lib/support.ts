/**
 * The team's contact details, published on the public safety page so that someone who cannot sign in (or has no
 * community yet) still has a way to reach a person. They come from the build environment and are validated here, so a
 * typo or a hostile value can never turn into a broken or unsafe link (only a plain address and a plain number pass).
 */
export interface SupportContact {
  email: string | null;
  phone: string | null;
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u;
const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/u;

export function parseSupport(email: string | undefined, phone: string | undefined): SupportContact {
  const e = email?.trim();
  const p = phone?.trim();
  return { email: e && EMAIL.test(e) ? e : null, phone: p && PHONE.test(p) ? p : null };
}

/** A tel: link with only digits and a leading plus. */
export const phoneHref = (phone: string): string => `tel:${phone.replace(/[^+0-9]/gu, "")}`;
