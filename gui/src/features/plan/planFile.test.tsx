import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client.js';
import { planFileKey, useChangePlanFile } from './planFile.js';

vi.mock('../../lib/api/client.js', () => ({ apiFetch: vi.fn() }));

it.each(['file', 'database'])('reuses the Add step requestId and %s observation even after the plan reloads', async (store) => {
  const client = new QueryClient();
  const file = { steps: [] };
  const database = { ...file, store: 'database', dbId: 'seen-db' };
  const firstView = store === 'database' ? database : file;
  const secondView = store === 'database' ? file : database;
  client.setQueryData(planFileKey('csv'), firstView);
  let mutation: ReturnType<typeof useChangePlanFile>;
  function PlanForm() {
    mutation = useChangePlanFile('csv');
    return null;
  }
  renderToStaticMarkup(<QueryClientProvider client={client}><PlanForm /></QueryClientProvider>);

  const fetch = vi.mocked(apiFetch);
  fetch.mockClear().mockRejectedValueOnce(new Error('503 Busy')).mockResolvedValue({ message: 'Added', plan: secondView });
  const change = { type: 'add', step: 'Add CSV export' } as const;
  mutation!.beginAdd();
  client.setQueryData(planFileKey('csv'), secondView);
  await expect(mutation!.mutateAsync(change)).rejects.toThrow('503 Busy');
  await mutation!.mutateAsync(change);
  await mutation!.mutateAsync(change);
  const [first, retry, newSubmission] = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(first).toMatchObject({ change, requestId: expect.any(String), store, ...(store === 'database' ? { dbId: database.dbId } : {}) });
  expect(retry).toEqual(first);
  expect(newSubmission).toMatchObject({ store: store === 'database' ? 'file' : 'database' });
  expect(newSubmission.requestId).not.toBe(first.requestId);
  client.clear();
});
