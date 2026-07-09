/**
 * Table detection has no client-side (mupdf.js) equivalent — find_tables was a
 * PyMuPDF Python-layer feature never ported to MuPDF core. extract-tables,
 * pdf-to-csv, and pdf-to-excel upload the PDF to the backend's PyMuPDF instead.
 */

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || '';

export interface ServerTable {
  page: number;
  tableIndex: number;
  rows: (string | null)[][];
  markdown: string;
  rowCount: number;
  colCount: number;
}

export async function fetchServerTables(file: File): Promise<ServerTable[]> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE_URL}/api/extract-tables`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    let detail = `Server error (${res.status})`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }

  const data = await res.json();
  return data.tables as ServerTable[];
}
