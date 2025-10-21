let allMarkets = [];
let selectedCategories = new Set();

// Category icons/emojis
const categoryIcons = {
    'Politics': '🏛️',
    'Sports': '⚽',
    'Crypto': '₿',
    'Economics': '📈',
    'Entertainment': '🎬',
    'Geopolitics': '🌍',
    'Technology': '💻',
    'Other': '📊'
};

// Load saved category preferences from localStorage
function loadCategoryPreferences() {
    const saved = localStorage.getItem('selectedCategories');
    if (saved) {
        try {
            selectedCategories = new Set(JSON.parse(saved));
        } catch (e) {
            selectedCategories = new Set();
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

// Reset all filters
function resetFilters() {
    selectedCategories.clear();
    saveCategoryPreferences();
    renderCategoryFilters();
    renderMarkets();
}

// Render category filter chips
function renderCategoryFilters() {
    const categoryCounts = {};
    allMarkets.forEach(market => {
        const category = market.category || 'Other';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });

    const sortedCategories = Object.keys(categoryCounts).sort();
    const filtersHtml = sortedCategories.map(category => {
        const count = categoryCounts[category];
        const icon = categoryIcons[category] || '📊';
        const isActive = selectedCategories.size === 0 || selectedCategories.has(category);
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

    const filteredMarkets = selectedCategories.size === 0
        ? allMarkets
        : allMarkets.filter(m => selectedCategories.has(m.category || 'Other'));

    if (filteredMarkets.length === 0) {
        contentEl.innerHTML = '<div class="no-results">No predictions match the selected categories.</div>';
        return;
    }

    const cardsHtml = filteredMarkets.map(market => createMarketCard(market)).join('');
    contentEl.innerHTML = `<div class="market-grid">${cardsHtml}</div>`;
}

function formatVolume(volume) {
    if (volume >= 1000000) {
        return `${(volume / 1000000).toFixed(2)}M`;
    }
    if (volume >= 1000) {
        return `${(volume / 1000).toFixed(1)}K`;
    }
    return `${volume.toFixed(0)}`;
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
    const diff = Math.floor((now - date) / 1000 / 60);

    if (diff < 1) return 'Updated just now';
    if (diff < 60) return `Updated ${diff} minute${diff > 1 ? 's' : ''} ago`;

    const hours = Math.floor(diff / 60);
    if (hours < 24) return `Updated ${hours} hour${hours > 1 ? 's' : ''} ago`;

    return `Updated ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

function formatChange(change, period) {
    if (change === null || change === undefined) {
        return `<span class="change-badge neutral">${period} —</span>`;
    }

    const absChange = Math.abs(change);
    const sign = change > 0 ? '+' : '';
    const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '';
    const className = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';

    return `<span class="change-badge ${className}">${period} ${arrow}${sign}${absChange.toFixed(1)}%</span>`;
}

function createMarketCard(market) {
    const daysRemaining = getDaysRemaining(market.endDateIso);

    // Use pre-computed statement and displayProbability from backend
    const statement = market.statement || market.question;
    const displayProbability = market.displayProbability || 50;
    const category = market.category || 'Other';
    const categoryIcon = categoryIcons[category] || '📊';

    const changes = market.priceChanges || {};
    const changesHtml = `
        ${formatChange(changes.hour1, '1H')}
        ${formatChange(changes.hours24, '24H')}
        ${formatChange(changes.days7, '7D')}
    `;

    // Use event slug if available (correct Polymarket URL format), otherwise fall back to market slug
    const url = market.eventSlug
        ? `https://polymarket.com/event/${market.eventSlug}`
        : `https://polymarket.com/${market.slug}`;

    return `
        <div class="market-card" onclick="window.open('${url}', '_blank')">
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
                        <span class="probability-value">${displayProbability}%</span>
                    </div>
                    <div class="probability-changes">
                        ${changesHtml}
                    </div>
                </div>
                <div class="probability-track">
                    <div class="probability-fill" style="width: ${displayProbability}%"></div>
                </div>
            </div>
        </div>
    `;
}

async function loadMarkets() {
    const contentEl = document.getElementById('content');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    try {
        const response = await fetch('data/markets.json?t=' + Date.now());

        if (!response.ok) {
            throw new Error(`Failed to load data: ${response.status}`);
        }

        const data = await response.json();

        if (data.lastUpdated) {
            lastUpdatedEl.textContent = formatLastUpdated(data.lastUpdated);
        }

        if (!data.markets || data.markets.length === 0) {
            contentEl.innerHTML = '<div class="no-results">No predictions closing in the next 90 days found.</div>';
            return;
        }

        // Store all markets globally (but only show top 100 by volume)
        // Backend returns all markets sorted by volume
        allMarkets = data.markets.slice(0, 100);

        // Load saved category preferences
        loadCategoryPreferences();

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

loadMarkets();
