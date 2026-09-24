import { useEffect, useMemo, useRef, useState } from 'react'

// ─── Backend wiring ────────────────────────────────────────────────────────
// Points at the FastAPI backend (app/main.py in the smartbuy-ai project).
// Override via a .env.local file (VITE_API_BASE_URL=https://your-tunnel-url)
// when this frontend isn't served from the same machine as the backend -
// e.g. inside Figma Make's hosted preview, which can't reach a
// 127.0.0.1 address on your own laptop.
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || 'http://127.0.0.1:8000'

interface Listing {
  product_id: string
  title: string
  source: string
  price: number
  currency: string
  rating: number | null
  review_count: number | null
  product_url: string
  thumbnail_url: string | null
  fetched_at: string
}

interface AlternativeListing extends Listing {
  value_score: number
  reasoning: string
}

interface SearchResponse {
  reply: string
  best_listing: Listing | null
  other_listings: Listing[]
  alternatives: AlternativeListing[]
  trace: unknown[]
}

async function searchProducts(query: string): Promise<SearchResponse> {
  const res = await fetch(`${API_BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })

  const rawBody = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(rawBody)
  } catch {
    data = null
  }

  if (!res.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? String((data as { detail: unknown }).detail) : null
    throw new Error(detail || rawBody || `Search failed (${res.status})`)
  }

  return data as SearchResponse
}

// ─── Display model ──────────────────────────────────────────────────────────
// Only fields the API actually returns - no invented discounts, specs, or
// delivery estimates the backend has no data for.
type Group = 'best' | 'platform' | 'alternative'

interface DisplayProduct {
  key: string
  id: string
  name: string
  platform: string
  price: number
  currency: string
  rating: number | null
  reviews: number | null
  image: string | null
  productUrl: string
  fetchedAt: string
  group: Group
  reasoning?: string
}

function fromListing(l: Listing, group: Group, reasoning?: string): DisplayProduct {
  return {
    key: `${group}-${l.product_id}`,
    id: l.product_id,
    name: l.title,
    platform: l.source || 'Unknown seller',
    price: l.price,
    currency: l.currency,
    rating: l.rating,
    reviews: l.review_count,
    image: l.thumbnail_url,
    productUrl: l.product_url,
    fetchedAt: l.fetched_at,
    group,
    reasoning,
  }
}

function toDisplayProducts(result: SearchResponse): DisplayProduct[] {
  const list: DisplayProduct[] = []
  if (result.best_listing) list.push(fromListing(result.best_listing, 'best'))
  for (const l of result.other_listings) list.push(fromListing(l, 'platform'))
  for (const a of result.alternatives) list.push(fromListing(a, 'alternative', a.reasoning))
  return list
}

const AGENT_STEPS = [
  'Parsing your query…',
  'Searching live retailer listings…',
  'Filtering out mismatched products…',
  'Comparing prices across platforms…',
  'Scoring genuine alternatives…',
  'Finalizing recommendation…',
]

const SUGGESTIONS = [
  'Sony WH-1000XM5 headphones',
  'boAt Airdopes 141',
  'iPhone 15 128GB',
  'Lenovo IdeaPad Slim 5 14 inch',
  'Samsung Galaxy S24',
]

const PLATFORM_PALETTE = ['#FF9900', '#2874f0', '#818cf8', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899']

function platformColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return PLATFORM_PALETTE[hash % PLATFORM_PALETTE.length]
}

const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%2313131f'/%3E%3Ctext x='50%25' y='50%25' fill='%233f3f46' font-family='sans-serif' font-size='13' text-anchor='middle' dy='.3em'%3ENo image%3C/text%3E%3C/svg%3E"

function formatPrice(price: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(price)
  } catch {
    return `${currency} ${price.toFixed(0)}`
  }
}

function Stars({ r }: { r: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <svg key={i} viewBox="0 0 12 12" className={`w-3 h-3 ${i <= Math.round(r) ? 'text-amber-400' : 'text-zinc-700'}`} fill="currentColor">
          <path d="M6 .5l1.4 2.9 3.1.5-2.3 2.2.5 3.1L6 7.8l-2.7 1.4.5-3.1L1.5 3.9l3.1-.5L6 .5z" />
        </svg>
      ))}
    </span>
  )
}

type Phase = 'idle' | 'searching' | 'results'
type FilterTab = 'all' | 'platforms' | 'alternatives'
type SortKey = 'relevance' | 'price' | 'rating'

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [agentStep, setAgentStep] = useState(0)
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<DisplayProduct | null>(null)
  const [wishlist, setWishlist] = useState<string[]>([])
  const [filter, setFilter] = useState<FilterTab>('all')
  const [sortBy, setSortBy] = useState<SortKey>('relevance')
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (phase !== 'searching') return
    setAgentStep(0)
    const id = window.setInterval(() => {
      setAgentStep(s => Math.min(s + 1, AGENT_STEPS.length - 1))
    }, 450)
    return () => window.clearInterval(id)
  }, [phase])

  const runSearch = async (q: string) => {
    if (!q.trim()) return
    setErrorMessage(null)
    setSearchResult(null)
    setSelected(null)
    setFilter('all')
    setPhase('searching')

    try {
      const result = await searchProducts(q)
      setSearchResult(result)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Search failed - please try again.')
    } finally {
      setTimeout(() => setPhase('results'), 350)
    }
  }

  const handleSubmit = () => runSearch(query)

  const reset = () => {
    setPhase('idle')
    setSearchResult(null)
    setErrorMessage(null)
    setSelected(null)
  }

  const allProducts = useMemo(() => (searchResult ? toDisplayProducts(searchResult) : []), [searchResult])
  const hasAlternatives = allProducts.some(p => p.group === 'alternative')
  const needsClarification = !errorMessage && searchResult !== null && !searchResult.best_listing

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'platforms', label: 'Same product, all platforms' },
  ]
  if (hasAlternatives) filterTabs.push({ key: 'alternatives', label: 'Better alternatives' })

  const visible = useMemo(() => {
    let list = allProducts
    if (filter === 'platforms') list = list.filter(p => p.group === 'best' || p.group === 'platform')
    if (filter === 'alternatives') list = list.filter(p => p.group === 'alternative')

    const sorted = [...list]
    if (sortBy === 'price') sorted.sort((a, b) => a.price - b.price)
    else if (sortBy === 'rating') sorted.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
    return sorted
  }, [allProducts, filter, sortBy])

  const toggleWish = (id: string) => setWishlist(w => (w.includes(id) ? w.filter(x => x !== id) : [...w, id]))

  const ratedProducts = allProducts.filter(p => p.rating != null)
  const avgRating = ratedProducts.length ? ratedProducts.reduce((s, p) => s + (p.rating ?? 0), 0) / ratedProducts.length : null
  const platformCount = new Set(allProducts.map(p => p.platform)).size
  const lowestPrice = allProducts.length
    ? formatPrice(Math.min(...allProducts.map(p => p.price)), allProducts[0].currency)
    : '—'

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#07070f', fontFamily: 'Inter, sans-serif' }}>

      {/* ── Nav ── */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}>
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="text-white font-semibold text-[15px]" style={{ fontFamily: 'Sora, sans-serif' }}>
            smart<span style={{ color: '#818cf8' }}>buy.ai</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {wishlist.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 bg-white/5 px-3 py-1.5 rounded-full">
              <svg className="w-3.5 h-3.5 text-pink-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
              </svg>
              {wishlist.length} saved
            </div>
          )}
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}>
            A
          </div>
        </div>
      </nav>

      {/* ── Hero / Search ── */}
      {phase === 'idle' && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 animate-fade-up">
          <div className="inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full border mb-8" style={{ borderColor: 'rgba(99,102,241,0.3)', color: '#818cf8', background: 'rgba(99,102,241,0.08)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            AI agent active · live retailer search
          </div>

          <h1 className="text-center text-4xl sm:text-5xl md:text-6xl font-bold text-white mb-3 leading-tight" style={{ fontFamily: 'Sora, sans-serif' }}>
            Shop smarter<br />
            <span style={{ background: 'linear-gradient(90deg, #818cf8, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              with your AI agent
            </span>
          </h1>
          <p className="text-zinc-500 text-base mb-10 text-center max-w-sm">
            Searches real, live listings across retailers - then compares prices and surfaces genuinely better alternatives.
          </p>

          {/* Search box */}
          <div className="w-full max-w-2xl">
            <div className="relative flex items-center rounded-2xl border" style={{ background: '#0e0e1c', borderColor: 'rgba(99,102,241,0.25)' }}>
              <div className="absolute left-4 text-zinc-500">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder='Search a specific product… "Sony WH-1000XM5 headphones"'
                className="flex-1 bg-transparent text-white placeholder-zinc-600 text-[15px] pl-12 pr-4 py-4 outline-none"
              />
              <button
                onClick={handleSubmit}
                disabled={!query.trim()}
                className="m-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-30"
                style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
              >
                Search
              </button>
            </div>

            {/* Suggestions */}
            <div className="flex flex-wrap gap-2 mt-4 justify-center">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => { setQuery(s); runSearch(s) }}
                  className="text-xs text-zinc-500 hover:text-zinc-200 px-3 py-1.5 rounded-full border border-white/5 hover:border-white/15 transition-all"
                  style={{ background: 'rgba(255,255,255,0.03)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Agent Thinking ── */}
      {phase === 'searching' && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16">
          <div className="w-full max-w-md">
            <div className="flex justify-center mb-10">
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 rounded-full opacity-20 animate-ping" style={{ background: 'radial-gradient(circle, #6366f1, #a855f7)' }} />
                <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}>
                  <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              </div>
            </div>

            <p className="text-center text-white font-semibold text-lg mb-1" style={{ fontFamily: 'Sora, sans-serif' }}>
              Searching for "{query}"
            </p>
            <p className="text-center text-zinc-500 text-sm mb-8">{AGENT_STEPS[agentStep]}</p>

            <div className="rounded-xl border border-white/5 overflow-hidden" style={{ background: '#0e0e1c' }}>
              {AGENT_STEPS.map((step, i) => (
                <div
                  key={step}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5 last:border-0 transition-all"
                  style={{ opacity: i < agentStep ? 1 : i === agentStep ? 0.7 : 0.25 }}
                >
                  <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                    {i < agentStep ? (
                      <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : i === agentStep ? (
                      <div className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-zinc-700" />
                    )}
                  </div>
                  <span className="text-xs" style={{ fontFamily: 'JetBrains Mono, monospace', color: i < agentStep ? '#a1a1aa' : i === agentStep ? '#e4e4e7' : '#3f3f46' }}>
                    {step}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {phase === 'results' && errorMessage && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 text-center animate-fade-up">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5" style={{ background: 'rgba(239,68,68,0.12)' }}>
            <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-white font-semibold mb-2" style={{ fontFamily: 'Sora, sans-serif' }}>Something went wrong</p>
          <p className="text-zinc-500 text-sm max-w-md mb-6">{errorMessage}</p>
          <button onClick={reset} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}>
            Try another search
          </button>
        </div>
      )}

      {/* ── Needs clarification (ambiguous query, no listing found) ── */}
      {phase === 'results' && needsClarification && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 text-center animate-fade-up">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5" style={{ background: 'rgba(99,102,241,0.12)' }}>
            <svg className="w-6 h-6" style={{ color: '#818cf8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-white font-semibold mb-2 max-w-lg" style={{ fontFamily: 'Sora, sans-serif' }}>
            {searchResult?.reply || 'Could you be more specific?'}
          </p>
          <div className="w-full max-w-md mt-4">
            <div className="relative flex items-center rounded-xl border" style={{ background: '#0e0e1c', borderColor: 'rgba(99,102,241,0.25)' }}>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                className="flex-1 bg-transparent text-white placeholder-zinc-600 text-sm pl-4 pr-2 py-3 outline-none"
                placeholder="Add the model, size, or spec…"
              />
              <button onClick={handleSubmit} className="m-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white" style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}>
                Search again
              </button>
            </div>
          </div>
          <button onClick={reset} className="mt-6 text-xs text-zinc-500 hover:text-zinc-300">← Start over</button>
        </div>
      )}

      {/* ── Results ── */}
      {phase === 'results' && !errorMessage && !needsClarification && (
        <div ref={resultsRef} className="flex-1 px-4 sm:px-6 py-6 max-w-7xl mx-auto w-full">

          {/* Query bar */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center mb-6 animate-fade-up">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <button onClick={reset} className="w-8 h-8 rounded-lg border border-white/10 flex items-center justify-center hover:border-white/20 transition flex-shrink-0">
                <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
              <div className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/8 text-sm text-zinc-300 min-w-0" style={{ background: '#0e0e1c' }}>
                <svg className="w-4 h-4 text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="truncate">{query}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {(['relevance', 'price', 'rating'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className="text-xs px-3 py-1.5 rounded-lg border transition-all capitalize"
                  style={sortBy === s
                    ? { background: 'rgba(99,102,241,0.2)', borderColor: 'rgba(99,102,241,0.5)', color: '#a5b4fc' }
                    : { background: 'transparent', borderColor: 'rgba(255,255,255,0.08)', color: '#71717a' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Assistant reply */}
          {searchResult?.reply && (
            <div className="rounded-xl border border-white/5 px-4 py-3 mb-6 text-sm text-zinc-300 animate-fade-up" style={{ background: '#0e0e1c', animationDelay: '0.03s' }}>
              {searchResult.reply}
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 animate-fade-up" style={{ animationDelay: '0.05s' }}>
            {[
              { label: 'Results', value: String(allProducts.length), sub: 'listings found' },
              { label: 'Lowest Price', value: lowestPrice, sub: 'across all platforms' },
              { label: 'Avg. Rating', value: avgRating != null ? avgRating.toFixed(1) + '/5' : '—', sub: 'across rated listings' },
              { label: 'Platforms', value: String(platformCount), sub: 'sellers compared' },
            ].map(stat => (
              <div key={stat.label} className="rounded-xl border border-white/5 p-4" style={{ background: '#0e0e1c' }}>
                <p className="text-[11px] text-zinc-600 uppercase tracking-widest font-medium mb-1">{stat.label}</p>
                <p className="text-xl font-bold text-white mb-0.5" style={{ fontFamily: 'Sora, sans-serif' }}>{stat.value}</p>
                <p className="text-[11px] text-zinc-600">{stat.sub}</p>
              </div>
            ))}
          </div>

          {/* Group filter */}
          <div className="flex gap-2 mb-6 overflow-x-auto pb-1 animate-fade-up" style={{ animationDelay: '0.1s' }}>
            {filterTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className="text-xs px-3.5 py-1.5 rounded-full border whitespace-nowrap transition-all"
                style={filter === tab.key
                  ? { background: 'linear-gradient(135deg, #6366f1, #a855f7)', borderColor: 'transparent', color: '#fff', fontWeight: 600 }
                  : { background: 'transparent', borderColor: 'rgba(255,255,255,0.08)', color: '#71717a' }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {visible.length === 0 && (
            <p className="text-zinc-500 text-sm">No listings in this view.</p>
          )}

          {/* Grid + Detail panel */}
          <div className="flex gap-5">
            <div className={`grid gap-4 flex-1 transition-all ${selected ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'}`}>
              {visible.map((product, idx) => (
                <article
                  key={product.key}
                  onClick={() => setSelected(s => (s?.key === product.key ? null : product))}
                  className="group rounded-2xl border overflow-hidden cursor-pointer transition-all animate-fade-up"
                  style={{
                    background: selected?.key === product.key ? '#0f0f20' : '#0e0e1c',
                    borderColor: selected?.key === product.key ? 'rgba(99,102,241,0.5)' : product.group === 'best' ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.06)',
                    animationDelay: `${idx * 0.04}s`,
                  }}
                >
                  {/* Image */}
                  <div className="relative h-44 overflow-hidden" style={{ background: '#13131f' }}>
                    <img
                      src={product.image || PLACEHOLDER_IMAGE}
                      alt={product.name}
                      loading="lazy"
                      onError={e => { (e.target as HTMLImageElement).src = PLACEHOLDER_IMAGE }}
                      className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500 opacity-90"
                    />
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(14,14,28,0.8) 0%, transparent 50%)' }} />

                    {/* Badge */}
                    {product.group === 'best' && (
                      <div className="absolute top-3 left-3 text-[11px] font-semibold px-2.5 py-1 rounded-lg text-white" style={{ background: '#10b981', opacity: 0.9 }}>
                        Lowest price
                      </div>
                    )}
                    {product.group === 'alternative' && (
                      <div className="absolute top-3 left-3 text-[11px] font-semibold px-2.5 py-1 rounded-lg text-white" style={{ background: '#8b5cf6', opacity: 0.9 }}>
                        Better alternative
                      </div>
                    )}

                    {/* Platform pill */}
                    <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-lg text-white" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}>
                      <span className="w-2 h-2 rounded-full" style={{ background: platformColor(product.platform) }} />
                      {product.platform}
                    </div>

                    {/* Wishlist */}
                    <button
                      onClick={e => { e.stopPropagation(); toggleWish(product.id) }}
                      className="absolute bottom-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
                    >
                      <svg className="w-3.5 h-3.5" fill={wishlist.includes(product.id) ? '#f43f5e' : 'none'} stroke={wishlist.includes(product.id) ? '#f43f5e' : '#a1a1aa'} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                    </button>
                  </div>

                  {/* Content */}
                  <div className="p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-widest font-semibold mb-1">{product.platform}</p>
                    <h3 className="text-[15px] font-semibold text-white mb-2 leading-snug line-clamp-2" style={{ fontFamily: 'Sora, sans-serif' }}>{product.name}</h3>

                    {product.rating != null && (
                      <div className="flex items-center gap-2 mb-3">
                        <Stars r={product.rating} />
                        <span className="text-xs font-semibold text-zinc-300">{product.rating.toFixed(1)}</span>
                        {product.reviews != null && <span className="text-[11px] text-zinc-600">({product.reviews.toLocaleString('en-IN')})</span>}
                      </div>
                    )}

                    {product.reasoning && (
                      <p className="text-[11px] text-zinc-500 leading-relaxed mb-3">{product.reasoning}</p>
                    )}

                    <div className="flex items-center justify-between">
                      <div className="text-lg font-bold text-white" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {formatPrice(product.price, product.currency)}
                      </div>
                      <div className="text-[11px] text-zinc-600">fetched just now</div>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            {/* Detail drawer */}
            {selected && (
              <div className="hidden lg:flex flex-col w-80 flex-shrink-0 rounded-2xl border border-white/8 overflow-hidden animate-fade-up" style={{ background: '#0e0e1c', height: 'fit-content', position: 'sticky', top: '80px' }}>
                <div className="relative h-48" style={{ background: '#13131f' }}>
                  <img src={selected.image || PLACEHOLDER_IMAGE} alt={selected.name} onError={e => { (e.target as HTMLImageElement).src = PLACEHOLDER_IMAGE }} className="w-full h-full object-contain opacity-80" />
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, #0e0e1c 0%, transparent 60%)' }} />
                  <button onClick={() => setSelected(null)} className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
                    <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <div className="p-5 space-y-4">
                  <div>
                    <p className="text-[10px] text-zinc-600 uppercase tracking-widest font-semibold mb-1">{selected.platform}</p>
                    <h3 className="text-base font-bold text-white leading-snug" style={{ fontFamily: 'Sora, sans-serif' }}>{selected.name}</h3>
                  </div>

                  {selected.rating != null && (
                    <div className="flex items-center gap-2">
                      <Stars r={selected.rating} />
                      <span className="text-xs text-zinc-400">{selected.rating.toFixed(1)}{selected.reviews != null ? ` · ${selected.reviews.toLocaleString('en-IN')} reviews` : ''}</span>
                    </div>
                  )}

                  {/* Agent note */}
                  <div className="rounded-xl p-3" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)' }}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <svg className="w-3 h-3" style={{ color: '#818cf8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#818cf8' }}>Agent Note</span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      {selected.reasoning
                        ? selected.reasoning
                        : selected.group === 'best'
                          ? `Cheapest of ${platformCount} platform${platformCount === 1 ? '' : 's'} compared for this search.`
                          : `Also listed on ${selected.platform} - fetched just now.`}
                    </p>
                  </div>

                  <div>
                    <p className="text-[10px] text-zinc-600 uppercase tracking-widest font-semibold mb-2">Details</p>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <div className="w-1 h-1 rounded-full bg-indigo-500 flex-shrink-0" />
                        Source: {selected.platform}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <div className="w-1 h-1 rounded-full bg-indigo-500 flex-shrink-0" />
                        Currency: {selected.currency}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <div className="w-1 h-1 rounded-full bg-indigo-500 flex-shrink-0" />
                        Fetched just now
                      </div>
                    </div>
                  </div>

                  <div className="pt-1">
                    <div className="text-2xl font-bold text-white mb-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatPrice(selected.price, selected.currency)}</div>
                    <a
                      href={selected.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full py-3 rounded-xl text-sm font-semibold text-white text-center transition-all"
                      style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                    >
                      View on {selected.platform} →
                    </a>
                    <button
                      onClick={() => toggleWish(selected.id)}
                      className="w-full mt-2 py-2.5 rounded-xl text-sm font-medium border border-white/8 transition-all"
                      style={{ color: wishlist.includes(selected.id) ? '#f43f5e' : '#71717a' }}
                    >
                      {wishlist.includes(selected.id) ? '♥ Saved' : '♡ Save to watchlist'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="border-t border-white/5 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-zinc-700">
          <span>smartbuy.ai · Live prices, fetched on every search</span>
          <span>This MVP compares prices only - open a listing and use "View on [seller]" to buy directly from them.</span>
        </div>
      </footer>
    </div>
  )
}
