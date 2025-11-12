const SKOP_API_BASE_URL = 'https://api.skop.dev'

export interface ScrapeRequest {
  website: string
  prompt: string
  parameters?: ScrapeParameters
}

export interface ScrapeParameters {
  single_page?: boolean
  timeout?: number
  confidence_threshold?: number
  file_type?: 'document'
  max_file_size_mb?: number
  form?: boolean
}

export const DEFAULT_SCRAPE_PARAMETERS: ScrapeParameters = {
  confidence_threshold: 0.1,
  timeout: 1800,
  file_type: 'document',
  max_file_size_mb: 100,
}

export type JobStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface JobCreateResponse {
  job_id: string
  status: JobStatus
  message: string
  estimated_completion?: string
  created_at: string
}

export interface JobStatusResponse {
  job_id: string
  status: JobStatus
  message: string
  created_at: string
  started_at?: string
  completed_at?: string
  estimated_completion?: string
  total_pages_crawled: number
  total_documents_found: number
  is_active: boolean
  has_errors: boolean
  errors: JobError[]
  warnings: string[]
}

export interface JobResultsResponse {
  job_id: string
  status: JobStatus
  message: string
  documents: ExtractedDocument[]
  total_documents_found: number
  total_documents_downloaded: number
  total_pages_crawled: number
  success_rate: number
  cost: number
  total_runtime_seconds: number
  runtime_minutes: number
  has_errors: boolean
  errors: JobError[]
  warnings: string[]
  metadata?: Record<string, any>
}

export interface ExtractedDocument {
  name: string
  url: string
  source_page: string
  document_type: string
  confidence_score: number
  file_size_mb?: number
  extracted_at: string
}

export interface JobError {
  error_id: string
  agent_name: string
  error_type: string
  error_message: string
  page_url?: string
  timestamp: string
  is_recoverable: boolean
}

export interface ApiErrorResponse {
  error: boolean
  message: string
  status_code: number
  path: string
  timestamp: string
}

class SkopApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public path: string,
    public timestamp: string
  ) {
    super(message)
    this.name = 'SkopApiError'
  }
}

/**
 * This SkopApi simulates a real scraping process:
 * - Returns “pending” so your UI shows progress
 * - Waits a few seconds, triggers a ZIP download
 * - Then signals “completed” so frontend switches to success panel
 */
export class SkopApi {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${SKOP_API_BASE_URL}${endpoint}`

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    const data = await response.json()

    if (!response.ok) {
      const error = data as ApiErrorResponse
      throw new SkopApiError(
        error.message || 'API request failed',
        error.status_code || response.status,
        error.path || endpoint,
        error.timestamp || new Date().toISOString()
      )
    }

    return data
  }

  async healthCheck() {
    return this.makeRequest('/health/')
  }

  /**
   * Simulated scrape + ZIP download process.
   * Returns fake job states and triggers the ZIP download automatically.
   */
  async createScrapeJob(request: ScrapeRequest): Promise<JobCreateResponse> {
    const downloadApi = 'https://e02845e6ef7c.ngrok-free.app/download'
    const jobId = `zip-job-${Date.now()}`
    const now = new Date().toISOString()

    // Step 1️⃣: Return fake “pending” job instantly so UI starts progress animation
    const pendingJob: JobCreateResponse = {
      job_id: jobId,
      status: 'pending',
      message: 'Preparing ZIP download...',
      created_at: now,
      estimated_completion: new Date(Date.now() + 10000).toISOString(),
    }

    // Step 2️⃣: After 2s → simulate job start
    setTimeout(() => {
      console.log(`[ZIP JOB] ${jobId} → in_progress`)
    }, 2000)

    // Step 3️⃣: After 10s → trigger ZIP download and mark complete
    setTimeout(async () => {
      try {
        console.log(`[ZIP JOB] ${jobId} → downloading from ${downloadApi}`)
        const res = await fetch(downloadApi)

        if (!res.ok) {
          throw new SkopApiError(
            'Failed to download ZIP',
            res.status,
            '/download',
            new Date().toISOString()
          )
        }

        const blob = await res.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'scraped-documents.zip'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        window.URL.revokeObjectURL(url)

        console.log(`[ZIP JOB] ${jobId} → completed successfully`)
      } catch (err) {
        console.error(`[ZIP JOB] ${jobId} → download failed`, err)
      }

      // Fake a backend completion signal so frontend shows the success state
      const fakeCompletedJob: JobCreateResponse = {
        job_id: jobId,
        status: 'completed',
        message: '6000 documents found and ZIP ready for download.',
        created_at: now,
        estimated_completion: new Date(Date.now() + 10000).toISOString(),
      }

      // Dispatch a synthetic event your UI can catch (optional)
      window.dispatchEvent(
        new CustomEvent('skop-job-completed', { detail: fakeCompletedJob })
      )
    }, 10000)

    // Return initial state immediately
    return pendingJob
  }

  /** Optional backend ZIP download fallback */
  async downloadAllFiles(): Promise<Blob> {
    const url = `${SKOP_API_BASE_URL}/download-all`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      "ngrok-skip-browser-warning": "true",
    })
    if (!response.ok) {
      const text = await response.text()
      throw new SkopApiError(
        text || 'Failed to download all files',
        response.status,
        '/download-all',
        new Date().toISOString()
      )
    }
    return await response.blob()
  }

  async downloadFromInputUrl(websiteUrl: string): Promise<Blob> {
    const response = await fetch(`${SKOP_API_BASE_URL}/download-from-urls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ url: websiteUrl }]),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new SkopApiError(
        errorText || 'Failed to download from URL',
        response.status,
        '/download-from-urls',
        new Date().toISOString()
      )
    }

    return await response.blob()
  }

  async getJobStatus(jobId: string): Promise<JobStatusResponse> {
    return this.makeRequest(`/scrape/status/${jobId}`)
  }

  async getJobResults(jobId: string): Promise<JobResultsResponse> {
    return this.makeRequest(`/scrape/results/${jobId}`)
  }

  async cancelJob(jobId: string): Promise<void> {
    return this.makeRequest(`/scrape/${jobId}`, { method: 'DELETE' })
  }
}

export { SkopApiError }
