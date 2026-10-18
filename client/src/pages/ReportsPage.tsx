import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { can, useAuth } from '../auth.js';
import { Button, Card, ErrorNote, Loading, SearchInput } from '../components.js';
import { ReportDocumentModal, ReportFormModal, ReportsTable, type ReportIndexRow } from '../reports.js';

export function ReportsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const patientFilter = params.get('patientId') ?? '';

  const [rows, setRows] = useState<ReportIndexRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(
        await api<ReportIndexRow[]>('/api/reports', {
          query: { patientId: patientFilter || undefined, limit: 200 }
        })
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [patientFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const term = search.trim().toLowerCase();
  const visible = term
    ? rows.filter(
        (row) =>
          row.title.toLowerCase().includes(term) ||
          row.patientName.toLowerCase().includes(term) ||
          row.mrn.toLowerCase().includes(term) ||
          (row.authorName ?? '').toLowerCase().includes(term)
      )
    : rows;

  function clearPatient() {
    const next = new URLSearchParams(params);
    next.delete('patientId');
    setParams(next, { replace: true });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Clinical reports ({rows.length})</h2>
          <p>Signed answers to a visit or an admission: findings, diagnosis, plan and the evidence behind them.</p>
        </div>
        {can(user, ['doctor']) && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New report
          </Button>
        )}
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search patient, MRN, title or author…" />
          {patientFilter && (
            <Button size="sm" variant="ghost" onClick={clearPatient}>
              Clear patient filter
            </Button>
          )}
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            Reload
          </Button>
        </div>

        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <Loading label="Loading reports…" />
        ) : (
          <ReportsTable rows={visible} onOpen={(row) => setOpened(row.id)} />
        )}

        {!can(user, ['doctor']) && (
          <p className="subtle" style={{ marginTop: 12 }}>
            Reports are signed by doctors. You can open and print the ones already written for your role.
          </p>
        )}
      </Card>

      {creating && (
        <ReportFormModal
          lockedPatientId={patientFilter || undefined}
          onClose={() => setCreating(false)}
          onSaved={load}
        />
      )}

      {opened && <ReportDocumentModal reportId={opened} onClose={() => setOpened(null)} onChanged={load} />}
    </>
  );
}
