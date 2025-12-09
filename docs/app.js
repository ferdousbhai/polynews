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
            <div class="category-chip ${isActive ? 'active' : ''}" onclick="toggleCategory('${category}')">
                <span>${category}</span>
                <span class="category-count">${count}</span>
            </div>
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

    filteredMarkets = [
        ...filteredMarkets
            .filter(m => (m.priceChanges?.hours24 || 0) >= 3)
            .sort((a, b) => (b.priceChanges?.hours24 || 0) - (a.priceChanges?.hours24 || 0)),
        ...filteredMarkets
            .filter(m => (m.priceChanges?.hours24 || 0) < 3)
    ];

    contentEl.innerHTML = `<div class="market-list">${filteredMarkets.map(market => createMarketItem(market)).join('')}</div>`;
}

function formatVolume(volume) {
    const num = Number(volume);
    if (!num || isNaN(num)) {
        return '0';
    }

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

async function fetchMarketsData() {
    const response = await fetch(`markets.json?t=${Date.now()}`);
    if (!response.ok) {
        throw new Error(`Failed to load data: ${response.status}`);
    }
    return response.json();
}

function isTrending(market) {
    return (market.priceChanges?.hours24 || 0) >= 3;
}

function createMarketItem(market) {
    const daysRemaining = getDaysRemaining(market.endDateIso);
    const statement = market.statement || market.question;
    const displayProbability = market.displayProbability || 50;
    const url = market.eventSlug
        ? `https://polymarket.com/event/${market.eventSlug}`
        : `https://polymarket.com/${market.slug}`;
    const trendingClass = isTrending(market) ? ' trending' : '';

    return `
        <div class="market-item${trendingClass}">
            <div class="vote-box">
                <span class="vote-count">${formatVolume(market.volume)}</span>
            </div>
            <div class="market-content">
                <div class="market-title-row">
                    <a href="${url}" target="_blank" class="market-title">${statement}</a>
                    <div class="probability-group">
                        <span class="probability-inline">${displayProbability}%</span>
                        <span class="days-inline">${daysRemaining}d</span>
                    </div>
                </div>
            </div>
        </div>
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

loadMarkets();

setInterval(() => {
    if (currentLastUpdated) {
        const lastUpdatedEl = document.getElementById('lastUpdated');
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = formatLastUpdated(currentLastUpdated);
        }
    }
}, 10000);

setInterval(async () => {
    try {
        const data = await fetchMarketsData();
        if (data.lastUpdated !== currentLastUpdated) loadMarkets();
    } catch {}
}, 60000);
