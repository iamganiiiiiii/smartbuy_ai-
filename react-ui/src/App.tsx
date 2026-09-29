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

interface Me {
  email: string
  member_since: string
  trial_searches_used: number
  free_trial_limit: number
  subscription_status: 'none' | 'active' | 'cancelled'
  subscription_renews_at: string | null
  price_label: string
}

// Thrown when /api/search returns 402 (free trial used up, no active
// subscription) - kept distinct from a generic Error so the UI can show an
// upgrade prompt instead of a "search failed" message.
class PaywallError extends Error {}

interface RazorpayCheckoutOptions {
  key: string
  subscription_id: string
  name: string
  description?: string
  handler: () => void
}
declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void }
  }
}

const TOKEN_STORAGE_KEY = 'smartbuy_token'

async function fetchMe(token: string): Promise<Me | null> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  return res.json()
}

async function searchProducts(query: string, token: string): Promise<SearchResponse> {
  const res = await fetch(`${API_BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  })

  const rawBody = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(rawBody)
  } catch {
    data = null
  }

  const detail = data && typeof data === 'object' && 'detail' in data ? String((data as { detail: unknown }).detail) : null

  if (res.status === 402) {
    throw new PaywallError(detail || 'Free trial used up.')
  }
  if (!res.ok) {
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
  const [paywalled, setPaywalled] = useState(false)
  const [selected, setSelected] = useState<DisplayProduct | null>(null)
  const [wishlist, setWishlist] = useState<string[]>([])
  const [filter, setFilter] = useState<FilterTab>('all')
  const [sortBy, setSortBy] = useState<SortKey>('relevance')
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY))
  const [me, setMe] = useState<Me | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [accountPanelOpen, setAccountPanelOpen] = useState(false)
  const accountPanelRef = useRef<HTMLDivElement>(null)

  const [forgotMode, setForgotMode] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotSubmitting, setForgotSubmitting] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)

  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get('reset_token'))
  const [resetNewPassword, setResetNewPassword] = useState('')
  const [resetSubmitting, setResetSubmitting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetDone, setResetDone] = useState(false)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changePasswordError, setChangePasswordError] = useState<string | null>(null)
  const [changePasswordSuccess, setChangePasswordSuccess] = useState(false)
  const [changePasswordSubmitting, setChangePasswordSubmitting] = useState(false)
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [listening, setListening] = useState(false)

  const setToken = (t: string | null) => {
    setTokenState(t)
    if (t) localStorage.setItem(TOKEN_STORAGE_KEY, t)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  }

  useEffect(() => {
    if (!accountPanelOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (accountPanelRef.current && !accountPanelRef.current.contains(e.target as Node)) setAccountPanelOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [accountPanelOpen])

  useEffect(() => {
    if (!token) {
      setAuthChecked(true)
      return
    }
    fetchMe(token).then(m => {
      if (m) setMe(m)
      else setToken(null)
      setAuthChecked(true)
    })
    // Only re-check on mount - subsequent refreshes happen explicitly after a search or subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)
    setAuthSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAuthError(data?.detail || 'Something went wrong.')
        return
      }
      setToken(data.token)
      const m = await fetchMe(data.token)
      if (m) setMe(m)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setAuthSubmitting(false)
    }
  }

  const handleLogout = () => {
    if (token) {
      fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
    }
    setToken(null)
    setMe(null)
    setPhase('idle')
    setSearchResult(null)
    setErrorMessage(null)
    setPaywalled(false)
    setSelected(null)
    setAccountPanelOpen(false)
  }

  const handleSubscribe = async () => {
    if (!token) return
    setSubscribing(true)
    try {
      const res = await fetch(`${API_BASE}/api/billing/create-subscription`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data?.detail || 'Could not start checkout.')
        return
      }
      if (!window.Razorpay) {
        alert('Payment widget failed to load - please refresh and try again.')
        return
      }
      const checkout = new window.Razorpay({
        key: data.key_id,
        subscription_id: data.subscription_id,
        name: 'SmartBuy AI',
        description: 'SmartBuy AI subscription',
        handler: async () => {
          const m = await fetchMe(token)
          if (m) setMe(m)
          setPaywalled(false)
        },
      })
      checkout.open()
    } finally {
      setSubscribing(false)
    }
  }

  const handleCancelSubscription = async () => {
    if (!token) return
    setCancelling(true)
    try {
      const res = await fetch(`${API_BASE}/api/billing/cancel-subscription`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const m = await fetchMe(token)
        if (m) setMe(m)
      } else {
        const data = await res.json().catch(() => null)
        alert(data?.detail || 'Could not cancel subscription.')
      }
    } finally {
      setCancelling(false)
    }
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setForgotSubmitting(true)
    try {
      await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      })
      // Always show success, matching the backend's "don't reveal which emails exist" behavior.
      setForgotSent(true)
    } finally {
      setForgotSubmitting(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resetToken) return
    setResetError(null)
    setResetSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, new_password: resetNewPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResetError(data?.detail || 'This reset link is invalid or has expired.')
        return
      }
      setResetDone(true)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setResetSubmitting(false)
    }
  }

  const goToLoginAfterReset = () => {
    window.history.replaceState({}, '', window.location.pathname)
    setResetToken(null)
    setAuthMode('login')
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    setChangePasswordError(null)
    setChangePasswordSuccess(false)
    setChangePasswordSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setChangePasswordError(data?.detail || 'Something went wrong.')
        return
      }
      setChangePasswordSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      setChangePasswordError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setChangePasswordSubmitting(false)
    }
  }

  const handleDeleteAccount = async () => {
    if (!token) return
    setDeleting(true)
    try {
      const res = await fetch(`${API_BASE}/api/auth/account`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setSettingsOpen(false)
        handleLogout()
      } else {
        const data = await res.json().catch(() => null)
        alert(data?.detail || 'Could not delete account.')
      }
    } finally {
      setDeleting(false)
    }
  }

  const startVoiceSearch = () => {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognitionCtor) {
      alert('Voice search needs a browser that supports the Web Speech API - try Chrome or Edge.')
      return
    }
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'en-IN'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript as string
      setQuery(transcript)
      runSearch(transcript)
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => setListening(false)
    setListening(true)
    recognition.start()
  }

  useEffect(() => {
    if (phase !== 'searching') return
    setAgentStep(0)
    const id = window.setInterval(() => {
      setAgentStep(s => Math.min(s + 1, AGENT_STEPS.length - 1))
    }, 450)
    return () => window.clearInterval(id)
  }, [phase])

  const runSearch = async (q: string) => {
    if (!q.trim() || !token) return
    setErrorMessage(null)
    setPaywalled(false)
    setSearchResult(null)
    setSelected(null)
    setFilter('all')
    setPhase('searching')

    try {
      const result = await searchProducts(q, token)
      setSearchResult(result)
      const m = await fetchMe(token)
      if (m) setMe(m)
    } catch (err) {
      if (err instanceof PaywallError) setPaywalled(true)
      else setErrorMessage(err instanceof Error ? err.message : 'Search failed - please try again.')
    } finally {
      setTimeout(() => setPhase('results'), 350)
    }
  }

  const handleSubmit = () => runSearch(query)

  const reset = () => {
    setPhase('idle')
    setSearchResult(null)
    setErrorMessage(null)
    setPaywalled(false)
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
          {me && wishlist.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 bg-white/5 px-3 py-1.5 rounded-full">
              <svg className="w-3.5 h-3.5 text-pink-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
              </svg>
              {wishlist.length} saved
            </div>
          )}
          {me && (
            <>
              <span className="hidden sm:inline text-xs text-zinc-400">
                {me.subscription_status === 'active' ? 'Subscribed' : `${Math.max(0, me.free_trial_limit - me.trial_searches_used)} free left`}
              </span>
              <div className="relative" ref={accountPanelRef}>
                <button
                  onClick={() => setAccountPanelOpen(o => !o)}
                  title={me.email}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white transition-transform hover:scale-105 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                >
                  {me.email[0]?.toUpperCase() ?? 'U'}
                </button>

                {accountPanelOpen && (
                  <div
                    className="absolute right-0 top-full mt-2 w-72 rounded-2xl border border-white/8 overflow-hidden z-50 animate-fade-up"
                    style={{ background: '#0e0e1c', boxShadow: '0 20px 40px rgba(0,0,0,0.45)' }}
                  >
                    <div className="p-4 border-b border-white/5 flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                      >
                        {me.email[0]?.toUpperCase() ?? 'U'}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{me.email}</p>
                        <p className="text-xs text-zinc-500">
                          {me.subscription_status === 'active' ? 'Subscribed' : me.subscription_status === 'cancelled' ? 'Cancelled' : 'Free'}
                        </p>
                      </div>
                    </div>
                    <div className="p-2">
                      {me.subscription_status !== 'active' && (
                        <button
                          onClick={() => {
                            setAccountPanelOpen(false)
                            handleSubscribe()
                          }}
                          className="w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg text-sm text-white hover:bg-white/5 transition-colors"
                        >
                          <svg className="w-4 h-4 flex-shrink-0" style={{ color: '#818cf8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                            />
                          </svg>
                          Upgrade plan
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setAccountPanelOpen(false)
                          setSettingsOpen(true)
                        }}
                        className="w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                      >
                        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                          />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Account settings
                      </button>
                      <div className="h-px bg-white/5 my-1" />
                      <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                      >
                        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.8}
                            d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3-3l3-3m0 0l-3-3m3 3H9"
                          />
                        </svg>
                        Log out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </nav>

      {/* ── Auth gate ── */}
      {resetToken ? (
        <div className="relative flex-1 flex flex-col items-center justify-center px-4 py-16 overflow-hidden animate-fade-up">
          <div
            className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[560px] h-[560px] rounded-full opacity-25 blur-3xl"
            style={{ background: 'radial-gradient(circle, #6366f1, transparent 70%)' }}
          />
          <div
            className="relative w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
            style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)', boxShadow: '0 10px 30px rgba(99,102,241,0.35)' }}
          >
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 10-8 0v4h8z" />
            </svg>
          </div>

          {resetDone ? (
            <>
              <h1 className="relative text-center text-3xl sm:text-4xl font-bold text-white mb-3" style={{ fontFamily: 'Sora, sans-serif' }}>
                Password updated
              </h1>
              <p className="relative text-zinc-500 text-sm mb-8 text-center max-w-sm">You can log in with your new password now.</p>
              <button
                onClick={goToLoginAfterReset}
                className="relative px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
                style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
              >
                Go to log in
              </button>
            </>
          ) : (
            <>
              <h1 className="relative text-center text-3xl sm:text-4xl font-bold text-white mb-3" style={{ fontFamily: 'Sora, sans-serif' }}>
                Set a new password
              </h1>
              <p className="relative text-zinc-500 text-sm mb-8 text-center max-w-sm">Choose a new password for your account.</p>
              <form onSubmit={handleResetPassword} className="relative w-full max-w-sm space-y-3">
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={resetNewPassword}
                  onChange={e => setResetNewPassword(e.target.value)}
                  placeholder="New password (min 8 characters)"
                  className="w-full rounded-xl border text-white placeholder-zinc-600 text-sm px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
                  style={{ background: '#0e0e1c', borderColor: 'rgba(99,102,241,0.25)' }}
                />
                {resetError && <p className="text-xs text-red-400">{resetError}</p>}
                <button
                  type="submit"
                  disabled={resetSubmitting}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                >
                  {resetSubmitting ? 'Saving…' : 'Save new password'}
                </button>
              </form>
            </>
          )}
        </div>
      ) : !authChecked ? (
        <div className="flex-1 flex items-center justify-center py-16">
          <div className="w-6 h-6 rounded-full border-2 border-white/10 animate-spin" style={{ borderTopColor: '#818cf8' }} />
        </div>
      ) : !me ? (
        <div className="relative flex-1 flex flex-col items-center justify-center px-4 py-16 overflow-hidden animate-fade-up">
          <div
            className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[560px] h-[560px] rounded-full opacity-25 blur-3xl"
            style={{ background: 'radial-gradient(circle, #6366f1, transparent 70%)' }}
          />

          <div
            className="relative w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
            style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)', boxShadow: '0 10px 30px rgba(99,102,241,0.35)' }}
          >
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>

          <h1 className="relative text-center text-3xl sm:text-4xl font-bold text-white mb-3 leading-tight" style={{ fontFamily: 'Sora, sans-serif' }}>
            {forgotMode ? 'Reset your password' : authMode === 'signup' ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="relative text-zinc-500 text-sm mb-8 text-center max-w-sm">
            {forgotMode
              ? "Enter your email and we'll send you a reset link."
              : authMode === 'signup'
                ? 'Sign up to get 5 free searches - then subscribe to keep going.'
                : 'Log in to keep comparing prices.'}
          </p>

          {forgotMode ? (
            forgotSent ? (
              <p className="relative text-sm text-zinc-400 text-center max-w-sm">
                If an account exists for that email, a reset link is on its way.
              </p>
            ) : (
              <form onSubmit={handleForgotPassword} className="relative w-full max-w-sm space-y-3">
                <input
                  type="email"
                  required
                  autoComplete="username"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  placeholder="Email"
                  className="w-full rounded-xl border text-white placeholder-zinc-600 text-sm px-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
                  style={{ background: '#0e0e1c', borderColor: 'rgba(99,102,241,0.25)' }}
                />
                <button
                  type="submit"
                  disabled={forgotSubmitting}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                >
                  {forgotSubmitting ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            )
          ) : (
          <form onSubmit={handleAuthSubmit} className="relative w-full max-w-sm space-y-3">
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <input
                type="email"
                required
                autoComplete="username"
                value={authEmail}
                onChange={e => setAuthEmail(e.target.value)}
                placeholder="Email"
                className="w-full rounded-xl border text-white placeholder-zinc-600 text-sm pl-11 pr-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
                style={{ background: '#0e0e1c', borderColor: 'rgba(99,102,241,0.25)' }}
              />
            </div>
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 10-8 0v4h8z" />
                </svg>
              </div>
              <input
                type="password"
                required
                minLength={8}
                autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                value={authPassword}
                onChange={e => setAuthPassword(e.target.value)}
                placeholder={authMode === 'signup' ? 'Password (min 8 characters)' : 'Password'}
                className="w-full rounded-xl border text-white placeholder-zinc-600 text-sm pl-11 pr-4 py-3 outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
                style={{ background: '#0e0e1c', borderColor: 'rgba(99,102,241,0.25)' }}
              />
            </div>
            {authMode === 'login' && (
              <button
                type="button"
                onClick={() => {
                  setForgotMode(true)
                  setForgotSent(false)
                  setForgotEmail(authEmail)
                }}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Forgot password?
              </button>
            )}
            {authError && (
              <p className="text-xs text-red-400 flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                {authError}
              </p>
            )}
            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:hover:translate-y-0 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
              style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
            >
              {authSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 animate-spin" style={{ borderTopColor: '#fff' }} />
                  {authMode === 'signup' ? 'Creating account…' : 'Logging in…'}
                </span>
              ) : authMode === 'signup' ? (
                'Create account'
              ) : (
                'Log in'
              )}
            </button>
          </form>
          )}

          <button
            onClick={() => {
              if (forgotMode) {
                setForgotMode(false)
                return
              }
              setAuthMode(m => (m === 'signup' ? 'login' : 'signup'))
              setAuthError(null)
            }}
            className="relative mt-5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {forgotMode
              ? 'Back to log in'
              : authMode === 'signup'
                ? 'Already have an account? Log in'
                : 'Need an account? Sign up'}
          </button>
        </div>
      ) : (
        <>
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
                placeholder={listening ? 'Listening…' : 'Search a specific product… "Sony WH-1000XM5 headphones"'}
                className="flex-1 bg-transparent text-white placeholder-zinc-600 text-[15px] pl-12 pr-4 py-4 outline-none"
              />
              <button
                type="button"
                onClick={startVoiceSearch}
                title="Voice search"
                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all hover:bg-white/5 flex-shrink-0"
                style={{ color: listening ? '#f43f5e' : '#71717a' }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3.75 3.75 0 01-3.75-3.75V6a3.75 3.75 0 117.5 0v6a3.75 3.75 0 01-3.75 3.75z"
                  />
                </svg>
              </button>
              <button
                onClick={handleSubmit}
                disabled={!query.trim()}
                className="m-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-30 disabled:hover:translate-y-0 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
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

      {/* ── Paywall (free trial used up, no active subscription) ── */}
      {phase === 'results' && paywalled && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 text-center animate-fade-up">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5" style={{ background: 'rgba(99,102,241,0.12)' }}>
            <svg className="w-6 h-6" style={{ color: '#818cf8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 10-8 0v4h8z" />
            </svg>
          </div>
          <p className="text-white font-semibold mb-2" style={{ fontFamily: 'Sora, sans-serif' }}>You've used all your free searches</p>
          <p className="text-zinc-500 text-sm max-w-md mb-6">
            Subscribe for {me?.price_label ?? 'a small monthly fee'} to keep comparing prices with the AI agent.
          </p>
          <button
            onClick={handleSubscribe}
            disabled={subscribing}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:hover:translate-y-0 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
            style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
          >
            {subscribing ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 animate-spin" style={{ borderTopColor: '#fff' }} />
                Starting checkout…
              </span>
            ) : (
              `Subscribe for ${me?.price_label ?? 'a small monthly fee'}`
            )}
          </button>
        </div>
      )}

      {/* ── Error ── */}
      {phase === 'results' && errorMessage && !paywalled && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 text-center animate-fade-up">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5" style={{ background: 'rgba(239,68,68,0.12)' }}>
            <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-white font-semibold mb-2" style={{ fontFamily: 'Sora, sans-serif' }}>Something went wrong</p>
          <p className="text-zinc-500 text-sm max-w-md mb-6">{errorMessage}</p>
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
            style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
          >
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
              <button
                onClick={handleSubmit}
                className="m-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:brightness-110 active:translate-y-0"
                style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
              >
                Search again
              </button>
            </div>
          </div>
          <button onClick={reset} className="mt-6 text-xs text-zinc-500 hover:text-zinc-300">← Start over</button>
        </div>
      )}

      {/* ── Results ── */}
      {phase === 'results' && !errorMessage && !needsClarification && !paywalled && (
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
                  className="group rounded-2xl border overflow-hidden cursor-pointer transition-all hover:-translate-y-1 hover:shadow-[0_12px_32px_rgba(0,0,0,0.35)] animate-fade-up"
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
                      className="block w-full py-3 rounded-xl text-sm font-semibold text-white text-center transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 shadow-[0_8px_24px_rgba(99,102,241,0.25)]"
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
        </>
      )}

      {/* ── Footer ── */}
      <footer className="border-t border-white/5 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-zinc-700">
          <span>smartbuy.ai · Live prices, fetched on every search</span>
          <span>This MVP compares prices only - open a listing and use "View on [seller]" to buy directly from them.</span>
        </div>
      </footer>

      {/* ── Account settings modal ── */}
      {settingsOpen && me && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-white/8 overflow-hidden animate-fade-up max-h-[85vh] overflow-y-auto"
            style={{ background: '#0e0e1c', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-white/5">
              <h2 className="text-lg font-bold text-white" style={{ fontFamily: 'Sora, sans-serif' }}>
                Account settings
              </h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors"
              >
                <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 space-y-6">
              {/* Profile */}
              <div>
                <p className="text-[11px] text-zinc-600 uppercase tracking-widest font-semibold mb-3">Profile</p>
                <div className="rounded-xl border border-white/5 p-4 space-y-1" style={{ background: '#13131f' }}>
                  <p className="text-sm text-white">{me.email}</p>
                  <p className="text-xs text-zinc-500">
                    Member since {new Date(me.member_since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
              </div>

              {/* Plan */}
              <div>
                <p className="text-[11px] text-zinc-600 uppercase tracking-widest font-semibold mb-3">Plan</p>
                <div className="rounded-xl border border-white/5 p-4" style={{ background: '#13131f' }}>
                  <p className="text-sm text-white font-semibold mb-1">
                    {me.subscription_status === 'active'
                      ? `Subscribed · ${me.price_label}`
                      : me.subscription_status === 'cancelled'
                        ? 'Cancelled'
                        : 'Free trial'}
                  </p>
                  <p className="text-xs text-zinc-500 mb-3">
                    {me.subscription_status === 'active' && me.subscription_renews_at
                      ? `Renews ${new Date(me.subscription_renews_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                      : `${Math.max(0, me.free_trial_limit - me.trial_searches_used)} of ${me.free_trial_limit} free searches left`}
                  </p>
                  {me.subscription_status === 'active' ? (
                    <button
                      onClick={handleCancelSubscription}
                      disabled={cancelling}
                      className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel subscription'}
                    </button>
                  ) : (
                    <button
                      onClick={handleSubscribe}
                      disabled={subscribing}
                      className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                      style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                    >
                      {subscribing ? 'Starting checkout…' : `Subscribe for ${me.price_label}`}
                    </button>
                  )}
                </div>
              </div>

              {/* Change password */}
              <div>
                <p className="text-[11px] text-zinc-600 uppercase tracking-widest font-semibold mb-3">Change password</p>
                <form onSubmit={handleChangePassword} className="space-y-2">
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                    className="w-full rounded-xl border text-white placeholder-zinc-600 text-sm px-4 py-2.5 outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
                    style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.08)' }}
                  />
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="New password (min 8 characters)"
                    className="w-full rounded-xl border text-white placeholder-zinc-600 text-sm px-4 py-2.5 outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
                    style={{ background: '#13131f', borderColor: 'rgba(255,255,255,0.08)' }}
                  />
                  {changePasswordError && <p className="text-xs text-red-400">{changePasswordError}</p>}
                  {changePasswordSuccess && <p className="text-xs text-emerald-400">Password updated.</p>}
                  <button
                    type="submit"
                    disabled={changePasswordSubmitting}
                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, #6366f1, #a855f7)' }}
                  >
                    {changePasswordSubmitting ? 'Saving…' : 'Update password'}
                  </button>
                </form>
              </div>

              {/* Danger zone */}
              <div>
                <p className="text-[11px] uppercase tracking-widest font-semibold mb-3" style={{ color: 'rgba(248,113,113,0.8)' }}>
                  Danger zone
                </p>
                <div className="rounded-xl border p-4" style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.2)' }}>
                  {!deleteConfirming ? (
                    <button onClick={() => setDeleteConfirming(true)} className="text-sm text-red-400 hover:text-red-300 transition-colors">
                      Delete account
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-zinc-400">
                        This permanently deletes your account and cancels any active subscription. This can't be undone.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={handleDeleteAccount}
                          disabled={deleting}
                          className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-50"
                        >
                          {deleting ? 'Deleting…' : 'Yes, delete my account'}
                        </button>
                        <button
                          onClick={() => setDeleteConfirming(false)}
                          className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:bg-white/5 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
