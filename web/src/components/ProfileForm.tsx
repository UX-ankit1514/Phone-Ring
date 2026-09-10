import { FormEvent, useState } from "react";
import { ArrowRight } from "lucide-react";
import { validateDisplayName } from "../utils/name";

export function ProfileForm({
  initialValue,
  onSave,
  onCancel,
}: {
  initialValue: string;
  onSave: (name: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateDisplayName(value);
    if (!result.valid) {
      setError(result.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(result.value);
    } catch {
      setError("We couldn't save your name. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="profile-form" onSubmit={submit} noValidate>
      <label htmlFor="display-name">What should we call you?</label>
      <p>This name appears on the shared phone when you ring it.</p>
      <div className="input-shell">
        <input
          id="display-name"
          name="displayName"
          autoComplete="name"
          autoFocus
          maxLength={60}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "name-error" : "name-hint"}
          placeholder="Your full name"
        />
        <span id="name-hint">2–50 characters</span>
      </div>
      {error && <p className="form-error" id="name-error">{error}</p>}
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="button-primary" disabled={saving}>
          {saving ? "Saving…" : "Continue"}
          {!saving && <ArrowRight aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}

