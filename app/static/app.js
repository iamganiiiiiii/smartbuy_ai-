const TOKEN_KEY = "smartbuy_token";

const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");
const signupForm = document.getElementById("signup-form");
const loginForm = document.getElementById("login-form");
const showLoginLink = document.getElementById("show-login");
const showSignupLink = document.getElementById("show-signup");
const authStatusEl = document.getElementById("auth-status");
const accountInfoEl = document.getElementById("account-info");
const logoutLink = document.getElementById("logout-link");
const upgradePanel = document.getElementById("upgrade-panel");
const subscribeButton = document.getElementById("subscribe-button");

const form = document.getElementById("search-form");
const queryInput = document.getElementById("query");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const button = form.querySelector("button");

const PLACEHOLDER_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23272b33'/%3E%3Ctext x='50%25' y='50%25' fill='%239aa0a6' font-family='sans-serif' font-size='14' text-anchor='middle' dy='.3em'%3ENo image%3C/text%3E%3C/svg%3E";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function refreshAccount() {
  const token = getToken();
  if (!token) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }

  const res = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    clearToken();
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }

  const me = await res.json();
  authView.classList.add("hidden");
  appView.classList.remove("hidden");

  const remaining = Math.max(0, me.free_trial_limit - me.trial_searches_used);
  accountInfoEl.textContent =
    me.subscription_status === "active"
      ? `${me.email} · Subscribed`
      : `${me.email} · ${remaining} free search${remaining === 1 ? "" : "es"} left`;

  upgradePanel.classList.toggle("hidden", me.subscription_status === "active" || remaining > 0);
}

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await authenticate("/api/auth/signup", {
    email: document.getElementById("signup-email").value.trim(),
    password: document.getElementById("signup-password").value,
  });
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await authenticate("/api/auth/login", {
    email: document.getElementById("login-email").value.trim(),
    password: document.getElementById("login-password").value,
  });
});

async function authenticate(endpoint, body) {
  authStatusEl.textContent = "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      authStatusEl.textContent = data?.detail || "Something went wrong.";
      return;
    }
    setToken(data.token);
    await refreshAccount();
  } catch (err) {
    authStatusEl.textContent = "Request failed: " + err.message;
  }
}

showLoginLink.addEventListener("click", (e) => {
  e.preventDefault();
  signupForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  showLoginLink.classList.add("hidden");
  showSignupLink.classList.remove("hidden");
});

showSignupLink.addEventListener("click", (e) => {
  e.preventDefault();
  loginForm.classList.add("hidden");
  signupForm.classList.remove("hidden");
  showSignupLink.classList.add("hidden");
  showLoginLink.classList.remove("hidden");
});

logoutLink.addEventListener("click", async (e) => {
  e.preventDefault();
  const token = getToken();
  if (token) {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  clearToken();
  await refreshAccount();
});

subscribeButton.addEventListener("click", async () => {
  const token = getToken();
  const res = await fetch("/api/billing/create-subscription", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data?.detail || "Could not start checkout.");
    return;
  }

  const checkout = new Razorpay({
    key: data.key_id,
    subscription_id: data.subscription_id,
    name: "SmartBuy AI",
    description: "SmartBuy AI subscription",
    handler: () => {
      refreshAccount();
    },
  });
  checkout.open();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = queryInput.value.trim();
  if (!query) return;

  button.disabled = true;
  statusEl.textContent = "Searching real listings and comparing...";
  resultEl.innerHTML = "";

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ query }),
    });

    const rawBody = await res.text();
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = null;
    }

    if (res.status === 402) {
      statusEl.textContent = "";
      resultEl.textContent = "";
      upgradePanel.classList.remove("hidden");
      return;
    }

    if (!res.ok) {
      statusEl.textContent = "";
      resultEl.textContent = data?.detail || rawBody || "Something went wrong.";
      return;
    }

    statusEl.textContent = "";
    renderResult(data);
    refreshAccount();
  } catch (err) {
    statusEl.textContent = "";
    resultEl.textContent = "Request failed: " + err.message;
  } finally {
    button.disabled = false;
  }
});

refreshAccount();

function renderResult(data) {
  resultEl.innerHTML = "";

  if (data.reply) {
    const replyEl = document.createElement("p");
    replyEl.className = "reply-text";
    replyEl.textContent = data.reply; // textContent only - never render model output as HTML
    resultEl.appendChild(replyEl);
  }

  if (data.best_listing) {
    const platformListings = [data.best_listing, ...(data.other_listings || [])];
    const cards = platformListings.map((listing, i) => buildProductCard(listing, null, i === 0));
    const heading = platformListings.length > 1 ? "Compare prices across platforms" : "Best price found";
    resultEl.appendChild(buildSection(heading, cards, "cards grid"));
  }

  if (data.alternatives && data.alternatives.length) {
    const cards = data.alternatives.map((alt) => buildProductCard(alt, alt.reasoning));
    resultEl.appendChild(buildSection("Better alternatives", cards, "cards grid"));
  }

  if (!data.best_listing && !(data.alternatives && data.alternatives.length) && !data.reply) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No results.";
    resultEl.appendChild(empty);
  }

  resultEl.appendChild(buildTrace(data.trace));
}

function buildSection(heading, cardEls, cardsClassName) {
  const section = document.createElement("section");
  section.className = "result-section";

  const h2 = document.createElement("h2");
  h2.textContent = heading;
  section.appendChild(h2);

  const cardsWrap = document.createElement("div");
  cardsWrap.className = cardsClassName;
  for (const card of cardEls) cardsWrap.appendChild(card);
  section.appendChild(cardsWrap);

  return section;
}

function buildProductCard(listing, reasoning, isBest) {
  const card = document.createElement("article");
  card.className = isBest ? "product-card is-best" : "product-card";

  const img = document.createElement("img");
  img.className = "product-thumb";
  img.src = listing.thumbnail_url || PLACEHOLDER_IMG;
  img.alt = listing.title || "Product image";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    img.src = PLACEHOLDER_IMG;
  });
  card.appendChild(img);

  const body = document.createElement("div");
  body.className = "product-body";
  card.appendChild(body);

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  body.appendChild(badgeRow);

  const badge = document.createElement("span");
  badge.className = "platform-badge";
  badge.textContent = listing.source || "Unknown seller";
  badgeRow.appendChild(badge);

  if (isBest) {
    const bestBadge = document.createElement("span");
    bestBadge.className = "best-badge";
    bestBadge.textContent = "Lowest price";
    badgeRow.appendChild(bestBadge);
  }

  const title = document.createElement("h3");
  title.className = "product-title";
  title.textContent = listing.title || "Untitled product";
  body.appendChild(title);

  const price = document.createElement("div");
  price.className = "product-price";
  price.textContent = formatPrice(listing.price, listing.currency);
  body.appendChild(price);

  if (listing.rating != null) {
    body.appendChild(buildRating(listing.rating, listing.review_count));
  }

  if (reasoning) {
    const why = document.createElement("p");
    why.className = "product-reasoning";
    why.textContent = reasoning;
    body.appendChild(why);
  }

  const meta = document.createElement("div");
  meta.className = "product-meta";
  meta.textContent = "Fetched just now";
  body.appendChild(meta);

  if (listing.product_url) {
    const link = document.createElement("a");
    link.className = "product-link";
    link.href = listing.product_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `View on ${listing.source || "seller"}`;
    body.appendChild(link);
  }

  return card;
}

function buildRating(rating, reviewCount) {
  const wrap = document.createElement("div");
  wrap.className = "product-rating";

  const stars = document.createElement("span");
  stars.className = "stars";
  const full = Math.round(rating);
  stars.textContent = "★".repeat(Math.min(5, Math.max(0, full))) + "☆".repeat(Math.max(0, 5 - full));
  wrap.appendChild(stars);

  const text = document.createElement("span");
  text.className = "rating-text";
  text.textContent = reviewCount != null ? `${rating.toFixed(1)} (${reviewCount.toLocaleString()} reviews)` : rating.toFixed(1);
  wrap.appendChild(text);

  return wrap;
}

function formatPrice(price, currency) {
  if (price == null) return "Price unavailable";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(price);
  } catch {
    return `${currency || ""} ${price}`.trim();
  }
}

function buildTrace(trace) {
  const details = document.createElement("details");
  details.className = "trace";
  const summary = document.createElement("summary");
  summary.textContent = "Show agent trace (tool calls & raw results)";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(trace, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  return details;
}
