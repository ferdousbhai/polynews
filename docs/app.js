let allMarkets = [];
let selectedCategories = new Set();
let currentLastUpdated = null;
let currentSortOrder = 'volume';

// Category icons/emojis
const categoryIcons = {
    'Politics': '🏛️',
    'Sports': '⚽',
    'Crypto': '₿',
    'Economics': '📈',
    'Entertainment': '🎬',
    'Geopolitics': '🌍',
    'Technology': '💻',
    'Science': '🔬',
    'Pop Culture': '⭐',
    'Legal': '⚖️',
    'Conspiracy': '👽',
    'Other': '📊'
};

// Load saved category preferences from localStorage
function loadCategoryPreferences() {
    const saved = localStorage.getItem('selectedCategories');
    if (saved) {
        try {
            selectedCategories = new Set(JSON.parse(saved));
        } catch (e) {
            // Default to all categories selected
            selectedCategories = new Set(Object.keys(categoryIcons));
        }
    } else {
        // First load: select all categories by default
        selectedCategories = new Set(Object.keys(categoryIcons));
    }

    // Load saved sort order
    const savedSort = localStorage.getItem('sortOrder');
    if (savedSort) {
        currentSortOrder = savedSort;
        const sortSelect = document.getElementById('sortBy');
        if (sortSelect) {
            sortSelect.value = savedSort;
        }
    }
}

// Save category preferences to localStorage
function saveCategoryPreferences() {
    localStorage.setItem('selectedCategories', JSON.stringify([...selectedCategories]));
}

// Toggle category selection
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

// Reset all filters (select all categories)
function resetFilters() {
    selectedCategories = new Set(Object.keys(categoryIcons));
    saveCategoryPreferences();
    renderCategoryFilters();
    renderMarkets();
}

// Change sort order
function changeSortOrder(sortOrder) {
    currentSortOrder = sortOrder;
    localStorage.setItem('sortOrder', sortOrder);
    renderMarkets();
}

// Render category filter chips
function renderCategoryFilters() {
    const categoryCounts = {};
    allMarkets.forEach(market => {
        const category = market.category || 'Other';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });

    // Sort categories by count (most markets first), but always put "Other" last
    const sortedCategories = Object.keys(categoryCounts).sort((a, b) => {
        if (a === 'Other') return 1;
        if (b === 'Other') return -1;
        return categoryCounts[b] - categoryCounts[a];
    });
    const filtersHtml = sortedCategories.map(category => {
        const count = categoryCounts[category];
        const icon = categoryIcons[category] || '📊';
        const isActive = selectedCategories.has(category);
        return `
            <div class="category-chip ${isActive ? 'active' : ''}" onclick="toggleCategory('${category}')">
                <span>${icon} ${category}</span>
                <span class="category-count">${count}</span>
            </div>
        `;
    }).join('');

    document.getElementById('categoryFilters').innerHTML = filtersHtml;
}

// Render filtered markets
function renderMarkets() {
    const contentEl = document.getElementById('content');

    let filteredMarkets = allMarkets.filter(m => selectedCategories.has(m.category || 'Other'));

    if (filteredMarkets.length === 0) {
        contentEl.innerHTML = '<div class="no-results">No predictions match the selected categories.</div>';
        return;
    }

    // Sort markets based on current sort order
    filteredMarkets.sort((a, b) => {
        if (currentSortOrder === 'volume') {
            return (b.volume || 0) - (a.volume || 0);
        } else if (currentSortOrder === 'daysLeft') {
            const daysA = getDaysRemaining(a.endDateIso);
            const daysB = getDaysRemaining(b.endDateIso);
            return daysA - daysB; // Ascending order - soonest first
        } else if (currentSortOrder === 'change1h') {
            const changeA = a.priceChanges?.hour1 || 0;
            const changeB = b.priceChanges?.hour1 || 0;
            return Math.abs(changeB) - Math.abs(changeA);
        } else if (currentSortOrder === 'change24h') {
            const changeA = a.priceChanges?.hours24 || 0;
            const changeB = b.priceChanges?.hours24 || 0;
            return Math.abs(changeB) - Math.abs(changeA);
        } else if (currentSortOrder === 'change7d') {
            const changeA = a.priceChanges?.days7 || 0;
            const changeB = b.priceChanges?.days7 || 0;
            return Math.abs(changeB) - Math.abs(changeA);
        }
        return 0;
    });

    const cardsHtml = filteredMarkets.map(market => createMarketCard(market)).join('');
    contentEl.innerHTML = `<div class="market-grid">${cardsHtml}</div>`;
}

function formatVolume(volume) {
    // Convert to number and handle invalid values
    const num = Number(volume);
    if (!num || isNaN(num)) {
        return '0';
    }

    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(2)}M`;
    }
    if (num >= 1000) {
        return `${(num / 1000).toFixed(1)}K`;
    }
    return `${num.toFixed(0)}`;
}

function getDaysRemaining(endDate) {
    const now = new Date();
    const end = new Date(endDate);
    const diff = end - now;
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return days;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function formatLastUpdated(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const totalMinutes = Math.floor((now - date) / 1000 / 60);

    if (totalMinutes < 1) return 'Updated just now';
    if (totalMinutes < 60) return `Updated ${totalMinutes} minute${totalMinutes > 1 ? 's' : ''} ago`;

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours < 24) {
        if (minutes === 0) {
            return `Updated ${hours} hour${hours > 1 ? 's' : ''} ago`;
        }
        return `Updated ${hours} hour${hours > 1 ? 's' : ''}, ${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    }

    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;

    if (remainingHours === 0) {
        return `Updated ${days} day${days > 1 ? 's' : ''} ago`;
    }
    return `Updated ${days} day${days > 1 ? 's' : ''}, ${remainingHours} hour${remainingHours > 1 ? 's' : ''} ago`;
}

function formatChange(change, period) {
    if (change === null || change === undefined) {
        return `<span class="change-badge neutral">${period} —</span>`;
    }

    const absChange = Math.abs(change);
    const sign = change > 0 ? '+' : change < 0 ? '-' : '';
    const className = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';

    return `<span class="change-badge ${className}">${period} ${sign}${absChange.toFixed(1)}%</span>`;
}

function calculateOdds(probability) {
    // Calculate decimal odds for the opposite side
    // If showing 65% Yes, the No side has 35% probability
    // Decimal odds = 100 / probability
    const oppositeProbability = 100 - probability;
    if (oppositeProbability <= 0 || oppositeProbability >= 100) {
        return null;
    }
    return (100 / oppositeProbability).toFixed(2);
}

async function fetchMarketsData() {
    const response = await fetch(`markets.json?t=${Date.now()}`);
    if (!response.ok) {
        throw new Error(`Failed to load data: ${response.status}`);
    }
    return response.json();
}

function isTrending(market) {
    const changes = market.priceChanges || {};
    return Math.abs(changes.hours24 || 0) >= 10 || Math.abs(changes.hour1 || 0) >= 5;
}

function createMarketCard(market) {
    const daysRemaining = getDaysRemaining(market.endDateIso);

    // Use pre-computed statement and displayProbability from backend
    const statement = market.statement || market.question;
    const displayProbability = market.displayProbability || 50;
    const category = market.category || 'Other';
    const categoryIcon = categoryIcons[category] || '📊';
    const trending = isTrending(market);

    const changes = market.priceChanges || {};
    const changesHtml = `
        ${formatChange(changes.hour1, '1H')}
        ${formatChange(changes.hours24, '24H')}
        ${formatChange(changes.days7, '7D')}
    `;

    const odds = calculateOdds(displayProbability);
    const oddsTooltip = odds ? `<div class="odds-tooltip">${odds}x payout on No</div>` : '';

    // Use event slug if available (correct Polymarket URL format), otherwise fall back to market slug
    const url = market.eventSlug
        ? `https://polymarket.com/event/${market.eventSlug}`
        : `https://polymarket.com/${market.slug}`;

    return `
        <div class="market-card${trending ? ' trending' : ''}" onclick="window.open('${url}', '_blank')">
            <div class="market-header">
                <div class="days-remaining">${daysRemaining} days left</div>
                <div class="market-volume">${formatVolume(market.volume)}</div>
            </div>
            <div class="market-category-badge">${categoryIcon} ${category}</div>
            <h3 class="market-title">${statement}</h3>
            <p class="market-description">${market.description || ''}</p>
            <div class="market-meta">
                <div class="meta-item">
                    <svg class="meta-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                    </svg>
                    Closes ${formatDate(market.endDateIso)}
                </div>
                ${market.liquidity ? `
                    <div class="meta-item">
                        <svg class="meta-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        ${formatVolume(market.liquidity)} liquidity
                    </div>
                ` : ''}
            </div>
            <div class="probability-section">
                <div class="probability-header">
                    <div class="probability-main">
                        <div class="probability-wrapper">
                            <span class="probability-value">${displayProbability}%</span>
                            ${oddsTooltip}
                        </div>
                    </div>
                    <div class="probability-changes">
                        ${changesHtml}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderTrendingHeadline() {
    const headlineEl = document.getElementById('trendingHeadline');
    if (!headlineEl || allMarkets.length === 0) {
        if (headlineEl) headlineEl.innerHTML = '';
        return;
    }

    // Get all trending (>=10% 24H or >=5% 1H)
    const trending = allMarkets.filter(isTrending);

    // If fewer than 3 trending, fill with top 24H movers
    let topMovers;
    if (trending.length >= 3) {
        topMovers = trending.sort((a, b) =>
            Math.abs(b.priceChanges?.hours24 || 0) - Math.abs(a.priceChanges?.hours24 || 0)
        );
    } else {
        const sorted = [...allMarkets].sort((a, b) =>
            Math.abs(b.priceChanges?.hours24 || 0) - Math.abs(a.priceChanges?.hours24 || 0)
        );
        topMovers = sorted.slice(0, 3);
    }

    const html = topMovers.map(market => {
        const statement = market.statement || market.question;
        return `<div class="trending-item">${statement}</div>`;
    }).join('');

    headlineEl.innerHTML = html;
}

async function loadMarkets() {
    const contentEl = document.getElementById('content');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    try {
        const data = await fetchMarketsData();

        // Store current timestamp for auto-refresh checks
        currentLastUpdated = data.lastUpdated;

        if (data.lastUpdated) {
            lastUpdatedEl.textContent = formatLastUpdated(data.lastUpdated);
        }

        if (!data.markets || data.markets.length === 0) {
            contentEl.innerHTML = '<div class="no-results">No predictions closing in the next 90 days found.</div>';
            return;
        }

        // Store all markets globally
        // Backend returns all markets sorted by volume
        allMarkets = data.markets;

        // Load saved category preferences
        loadCategoryPreferences();

        // Render trending headline
        renderTrendingHeadline();

        // Render category filters
        renderCategoryFilters();

        // Render markets with initial filter state
        renderMarkets();

    } catch (error) {
        console.error('Error loading markets:', error);
        contentEl.innerHTML = `
            <div class="error">
                <strong>Error loading predictions</strong><br>
                ${error.message}<br><br>
                Please try refreshing the page.
            </div>
        `;
    }
}

// Initial load
loadMarkets();

// Update the "Updated X ago" text every 10 seconds to keep it current
setInterval(() => {
    if (currentLastUpdated) {
        const lastUpdatedEl = document.getElementById('lastUpdated');
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = formatLastUpdated(currentLastUpdated);
        }
    }
}, 10000); // Update every 10 seconds

// Auto-refresh: Check for new data every 60 seconds
setInterval(async () => {
    try {
        const data = await fetchMarketsData();

        // If data has been updated, reload everything
        if (data.lastUpdated !== currentLastUpdated) {
            console.log('New data detected, refreshing...');
            loadMarkets();
        }
    } catch (error) {
        // Silently fail - don't disrupt user experience
        console.error('Auto-refresh check failed:', error);
    }
}, 60000); // Check every 60 seconds
