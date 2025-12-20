const POLYMARKET_URL = 'https://polymarket.com';
const POLYMARKET_REF = '?via=ferdous-bhai';

let allMarkets = [];
let selectedCategories = new Set();
let currentLastUpdated = null;

function getAllCategoriesFromData() {
    return [...new Set(allMarkets.map(m => m.category || 'Uncategorized'))];
}

function loadCategoryPreferences() {
    const saved = localStorage.getItem('selectedCategories');
    if (saved) {
        const savedCategories = new Set(JSON.parse(saved));
        const allFromData = getAllCategoriesFromData();
        allFromData.forEach(cat => {
            if (!savedCategories.has(cat)) savedCategories.add(cat);
        });
        selectedCategories = savedCategories;
    } else {
        selectedCategories = new Set(getAllCategoriesFromData());
    }
}

function saveCategoryPreferences() {
    localStorage.setItem('selectedCategories', JSON.stringify([...selectedCategories]));
}

function toggleCategory(category) {
    if (selectedCategories.has(category)) {
        selectedCategories.delete(category);
    } else {
        selectedCategories.add(category);
    }
    saveCategoryPreferences();
    renderCategoryFilters();
    renderMarkets();
}

function renderCategoryFilters() {
    const categoryCounts = {};
    allMarkets.forEach(market => {
        const category = market.category || 'Uncategorized';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });

    const sortedCategories = Object.keys(categoryCounts).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return categoryCounts[b] - categoryCounts[a];
    });

    const filtersHtml = sortedCategories.map(category => {
        const count = categoryCounts[category];
        const isActive = selectedCategories.has(category);
        return `
            <button class="category-chip ${isActive ? 'active' : ''}"
                    onclick="toggleCategory('${category}')"
                    aria-pressed="${isActive}">
                <span>${category}</span>
                <span class="category-count">${count}</span>
            </button>
        `;
    }).join('');

    document.getElementById('categoryFilters').innerHTML = filtersHtml;
}

function renderMarkets() {
    const contentEl = document.getElementById('content');

    let filteredMarkets = allMarkets.filter(m => selectedCategories.has(m.category || 'Uncategorized'));

    if (filteredMarkets.length === 0) {
        contentEl.innerHTML = '<div class="no-results">No predictions match the selected categories.</div>';
        return;
    }

    // Separate trending and regular markets
    const trendingMarkets = filteredMarkets
        .filter(m => (m.priceChanges?.hours24 || 0) >= 3)
        .sort((a, b) => (b.priceChanges?.hours24 || 0) - (a.priceChanges?.hours24 || 0));

    const regularMarkets = filteredMarkets
        .filter(m => (m.priceChanges?.hours24 || 0) < 3);

    const sortedMarkets = [...trendingMarkets, ...regularMarkets];

    contentEl.innerHTML = `<div class="market-list">${sortedMarkets.map(market => createMarketItem(market)).join('')}</div>`;
}

function formatVolume(volume) {
    const num = Number(volume);
    if (!num || isNaN(num)) return '0';

    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
        return `${(num / 1000).toFixed(0)}K`;
    }
    return `${num.toFixed(0)}`;
}

function getDaysRemaining(endDate) {
    const now = new Date();
    const end = new Date(endDate);
    const diff = end - now;
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatLastUpdated(timestamp) {
    const mins = Math.floor((Date.now() - new Date(timestamp)) / 60000);
    if (mins < 1) return 'Updated just now';
    if (mins < 60) return `Updated ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Updated ${hrs}h ago`;
    return `Updated ${Math.floor(hrs / 24)}d ago`;
}

async function fetchMarketsData() {
    const response = await fetch(`markets.json?t=${Date.now()}`);
    if (!response.ok) {
        throw new Error(`Failed to load data: ${response.status}`);
    }
    return response.json();
}

function createMarketItem(market) {
    const days = getDaysRemaining(market.endDateIso);
    const title = market.statement || market.question;
    const prob = market.displayProbability || 50;
    const url = market.eventSlug
        ? `${POLYMARKET_URL}/event/${market.eventSlug}${POLYMARKET_REF}`
        : `${POLYMARKET_URL}/${market.slug}${POLYMARKET_REF}`;
    const isTrending = (market.priceChanges?.hours24 || 0) >= 3;
    const priceChange = market.priceChanges?.hours24 || 0;

    // Determine probability color class
    const probClass = prob >= 70 ? '' : 'medium';

    return `
        <article class="market-item${isTrending ? ' trending' : ''}">
            <div class="vote-box">
                <span class="volume-value">${formatVolume(market.volume)}</span>
                <span class="volume-label">vol</span>
            </div>
            <div class="market-content">
                ${isTrending ? `<div class="trending-badge">${priceChange.toFixed(0)}% today</div>` : ''}
                <div class="market-title-row">
                    <a href="${url}" target="_blank" rel="noopener" class="market-title">${title}</a>
                    <div class="probability-group">
                        <span class="probability ${probClass}">${prob}%</span>
                        <span class="days-remaining">${days}d</span>
                    </div>
                </div>
            </div>
        </article>
    `;
}

async function loadMarkets() {
    const contentEl = document.getElementById('content');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    try {
        const data = await fetchMarketsData();

        currentLastUpdated = data.lastUpdated;

        if (data.lastUpdated) {
            lastUpdatedEl.textContent = formatLastUpdated(data.lastUpdated);
        }

        if (!data.markets || data.markets.length === 0) {
            contentEl.innerHTML = '<div class="no-results">No predictions closing in the next 90 days found.</div>';
            return;
        }

        allMarkets = data.markets;

        loadCategoryPreferences();
        renderCategoryFilters();
        renderMarkets();

    } catch (error) {
        contentEl.innerHTML = `<div class="error"><strong>Error loading predictions</strong><br>${error.message}</div>`;
    }
}

// Initialize
loadMarkets();

// Update "last updated" text every 10 seconds
setInterval(() => {
    if (currentLastUpdated) {
        const lastUpdatedEl = document.getElementById('lastUpdated');
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = formatLastUpdated(currentLastUpdated);
        }
    }
}, 10000);

// Check for new data every 60 seconds
setInterval(async () => {
    try {
        const data = await fetchMarketsData();
        if (data.lastUpdated !== currentLastUpdated) loadMarkets();
    } catch {}
}, 60000);
