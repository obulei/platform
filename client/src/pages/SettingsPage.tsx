import { useEffect, useState } from 'react';
import { facilitySettings, type FacilityBranding } from '../api';
import { useAuth } from '../auth';
import { markFor } from '../branding';
import { Button, Card, ErrorNote, Field, Input, Loading, Textarea } from '../components';

/**
 * How this hospital presents itself to its own staff: the letter in the brand
 * square, the line under its name, the colour of its screens, and the two
 * sentences printed on a clinical report.
 *
 * Nothing here is clinical data and nothing here is another hospital's. The API
 * writes the single registry row named by this session's token, so what is typed
 * lands on the sign-in screen of the people who work here and on the reports they
 * hand to patients — which is why every field is optional: leaving one blank puts
 * the shared default back.
 */
export function SettingsPage() {
  const { user, saveFacility } = useAuth();
  const [form, setForm] = useState<FacilityBranding | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    facilitySettings
      .read()
      .then((result) => {
        if (!alive) return;
        const { mark, tagline, accent, reportCaption, reportFootnote } = result.facility;
        setForm({ mark, tagline, accent, reportCaption, reportFootnote });
      })
      .catch((cause) => alive && setError(cause));
    return () => {
      alive = false;
    };
  }, []);

  if (!user) return null;
  if (!form) return error ? <ErrorNote error={error} /> : <Loading label="Loading this hospital’s wording…" />;

  const name = user.facility.name;
  const setValue = (key: keyof FacilityBranding) => (event: { target: { value: string } }) => {
    setForm((current) => (current ? { ...current, [key]: event.target.value } : current));
    setSaved(false);
  };

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const facility = await facilitySettings.save({
        mark: form.mark.trim(),
        tagline: form.tagline.trim(),
        accent: form.accent.trim().toLowerCase(),
        reportCaption: form.reportCaption.trim(),
        reportFootnote: form.reportFootnote.trim()
      });
      const { mark, tagline, accent, reportCaption, reportFootnote } = facility;
      setForm({ mark, tagline, accent, reportCaption, reportFootnote });
      // The session carries the wording, so re-storing it moves the sidebar, the
      // browser tab and every printed report without signing anyone out.
      saveFacility(facility);
      setSaved(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <Card
        title="This hospital"
        subtitle="Staff see these words on every screen and on the reports they print for patients."
      >
        <div className="form-grid">
          <Field label="Hospital name" hint="Only the platform operator can rename a hospital, because the name is also an address staff may type.">
            <Input value={name} readOnly />
          </Field>
          <Field label="Sign-in address" hint="What staff type to reach this hospital. It never changes.">
            <Input value={user.facility.slug} readOnly className="mono" />
          </Field>
        </div>
      </Card>

      <Card title="Identity" subtitle="Leave any of these blank to use the default instead.">
        <div className="form-grid">
          <Field label="Brand mark" hint="One or two characters for the square beside the name. Blank uses the first letter of the hospital name.">
            <Input value={form.mark} onChange={setValue('mark')} maxLength={2} placeholder={markFor(name)} />
          </Field>
          <Field label="Accent colour" hint="A hex colour like #12628f. Blank keeps the default blue. It recolours buttons, links and report rules.">
            <Input
              value={form.accent}
              onChange={setValue('accent')}
              maxLength={7}
              placeholder="#12628f"
              className="mono"
            />
          </Field>
          <Field label="Line under the name" className="form-span-2" hint="Shown in the sidebar. Blank uses the software's own description.">
            <Input value={form.tagline} onChange={setValue('tagline')} maxLength={60} placeholder="e.g. Private specialist clinic" />
          </Field>
        </div>
      </Card>

      <Card title="Printed reports" subtitle="The two lines a report carries besides the hospital name.">
        <div className="stack">
          <Field label="Heading line" hint="Under the name at the top of every report. Blank uses “Clinical report”.">
            <Input value={form.reportCaption} onChange={setValue('reportCaption')} maxLength={80} placeholder="Clinical report" />
          </Field>
          <Field label="Footnote" hint="The closing sentence at the foot of every report. Blank states that the document came from this hospital's record and is logged.">
            <Textarea value={form.reportFootnote} onChange={setValue('reportFootnote')} maxLength={160} rows={3} />
          </Field>
        </div>
      </Card>

      <Card title="Preview" subtitle="How the sidebar will read, with the defaults filled in.">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" style={form.accent ? { background: form.accent } : undefined}>
            {form.mark.trim() || markFor(name)}
          </span>
          <span className="brand-text">
            <strong>{name}</strong>
            <span>{form.tagline.trim() || 'Default description'}</span>
          </span>
        </div>
        <p className="subtle">
          {form.reportCaption.trim() || 'Clinical report'} ·{' '}
          {form.reportFootnote.trim() || `Issued from the ${name} record.`}
        </p>
      </Card>

      <div className="toolbar">
        <Button variant="primary" onClick={() => void save()} loading={saving}>
          Save identity
        </Button>
        {saved && <span className="subtle">Saved. Every screen now shows it.</span>}
      </div>
    </div>
  );
}
