export type NameValidation =
  | { valid: true; value: string }
  | { valid: false; message: string };

export function validateDisplayName(input: string): NameValidation {
  const value = input.normalize("NFC").trim().replace(/\s+/gu, " ");
  const length = Array.from(value).length;

  if (length < 2) {
    return { valid: false, message: "Enter at least 2 characters." };
  }
  if (length > 50) {
    return { valid: false, message: "Keep your name to 50 characters or fewer." };
  }
  if (/[<>\p{Cc}]/u.test(value)) {
    return { valid: false, message: "Use a plain-text name without markup." };
  }
  return { valid: true, value };
}

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/u)[0] || displayName;
}

