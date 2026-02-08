/**
 * Interactive Telegram Bot for Price Alerts
 * Sends notifications and responds to commands from Telegram
 */

const TelegramBot = require('node-telegram-bot-api');

class TelegramNotifier {
    constructor(token, chatId) {
        // Support multiple chat IDs (comma-separated in env)
        this.authorizedChats = new Set();
        if (chatId) {
            // Split by comma and add all chat IDs
            chatId.toString().split(',').forEach(id => {
                const trimmedId = id.trim();
                this.authorizedChats.add(trimmedId);
                console.log(`   Adding authorized chat: "${trimmedId}" (length: ${trimmedId.length})`);
            });
        }
        this.chatId = chatId; // Primary chat for sending alerts
        this.bot = null;
        this.enabled = false;
        this.alertManager = null;
        this.derivClient = null;
        
        // Watchlist: symbols with periodic Telegram updates
        this.watchlist = new Map(); // symbol -> { interval, lastPrice, updateIntervalSec }
        this.defaultWatchInterval = 300; // Send update every 5 minutes (300 seconds)

        if (token && chatId) {
            try {
                // Enable polling to receive messages from Telegram
                this.bot = new TelegramBot(token, { polling: true });
                this.enabled = true;
                this.setupCommands();
                this.registerCommandMenu(); // Register commands with Telegram
                console.log('✅ Telegram bot initialized (interactive mode)');
                console.log(`📱 Authorized chats: ${[...this.authorizedChats].join(', ')}`);
            } catch (error) {
                console.error('❌ Failed to initialize Telegram bot:', error.message);
            }
        } else {
            console.log('⚠️ Telegram not configured - alerts will only show in console');
        }
    }

    // Register commands with Telegram so they show in the / menu
    async registerCommandMenu() {
        if (!this.bot) return;
        
        try {
            // Set the command list
            await this.bot.setMyCommands([
                { command: 'help', description: 'Show all commands' },
                { command: 'symbols', description: 'List all available symbols' },
                { command: 'prices', description: 'Show current monitored prices' },
                { command: 'price', description: 'Get price for symbol (e.g. /price BTC)' },
                { command: 'alert', description: 'Add alert (e.g. /alert BTC above 95000)' },
                { command: 'list', description: 'List all your alerts' },
                { command: 'remove', description: 'Remove alert by ID (e.g. /remove 1)' },
                { command: 'clear', description: 'Clear triggered alerts' },
                { command: 'watch', description: 'Watch with live updates (e.g. /watch BTC)' },
                { command: 'unwatch', description: 'Stop watching (e.g. /unwatch BTC)' },
                { command: 'watchlist', description: 'Show symbols being watched' },
                { command: 'search', description: 'Search symbols (e.g. /search gold)' }
            ]);
            
            // Set the Menu button to show commands
            await this.bot.setChatMenuButton({
                menu_button: {
                    type: 'commands'
                }
            });
            
            console.log('📋 Telegram command menu registered');
        } catch (error) {
            console.error('Failed to register commands:', error.message);
        }
    }

    // Set references to other components for interactive commands
    setComponents(alertManager, derivClient) {
        this.alertManager = alertManager;
        this.derivClient = derivClient;
    }

    // Check if chat is authorized
    isAuthorized(chatId) {
        const id = chatId.toString();
        // Debug: check exact values
        for (const authId of this.authorizedChats) {
            if (authId === id) return true;
            // Also check if it's a close match (in case of whitespace issues)
            if (authId.trim() === id.trim()) {
                console.log(`⚠️ Whitespace issue detected - fixing authorization`);
                return true;
            }
        }
        return false;
    }

    // Setup command handlers
    setupCommands() {
        if (!this.bot) return;

        // Log all incoming messages (for debugging chat IDs)
        this.bot.on('message', (msg) => {
            const chatId = msg.chat.id;
            const chatIdStr = chatId.toString();
            const chatType = msg.chat.type; // 'private', 'group', 'supergroup'
            const chatTitle = msg.chat.title || msg.chat.username || 'Private';
            
            if (!this.isAuthorized(chatId)) {
                console.log(`⚠️ Unauthorized message from ${chatType} "${chatTitle}"`);
                console.log(`   Received ID: "${chatIdStr}" (length: ${chatIdStr.length})`);
                console.log(`   Authorized IDs: ${[...this.authorizedChats].map(id => `"${id}"`).join(', ')}`);
                console.log(`   To authorize, add this ID to TELEGRAM_CHAT_ID in .env`);
            }
        });

        // /start or /help - Show available commands (case-insensitive)
        this.bot.onText(/\/(start|help)/i, (msg) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id; // Update active chat
            this.sendHelp();
        });

        // /price [symbol] - Get current price
        this.bot.onText(/\/price(?:\s+(.+))?/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            const symbol = match[1]?.toUpperCase()?.trim()?.replace('_', '_');
            this.handlePriceCommand(symbol);
        });

        // /prices - Get all current prices
        this.bot.onText(/\/prices/i, (msg) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleAllPricesCommand();
        });

        // /alert <symbol> <above|below|crosses> <price> - Add single alert
        this.bot.onText(/\/alert\s+(\S+)\s+(above|below|crosses)\s+([\d.]+)/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            const symbol = match[1].trim();
            const condition = match[2].toLowerCase();
            const price = parseFloat(match[3]);
            this.handleAddAlert(symbol, condition, price);
        });

        // /alerts - Multiple alerts with different conditions (comma separated)
        // Format: /alerts BTC above 95000, ETH below 2000, XAU crosses 2900
        this.bot.onText(/\/alerts\s+(.+)/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleMultipleAlerts(match[1]);
        });

        // /list - List all alerts
        this.bot.onText(/\/list/i, (msg) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleListAlerts();
        });

        // /remove <id> - Remove alert by ID
        this.bot.onText(/\/remove\s+(\d+)/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            const id = parseInt(match[1]);
            this.handleRemoveAlert(id);
        });

        // /clear - Clear all triggered alerts
        this.bot.onText(/\/clear/i, (msg) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleClearTriggered();
        });

        // /watch <symbol> [interval] - Watch with periodic Telegram updates
        this.bot.onText(/\/watch\s+(\S+)(?:\s+(\d+))?/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            const interval = match[2] ? parseInt(match[2]) : this.defaultWatchInterval;
            this.handleWatch(match[1], interval);
        });

        // /unwatch <symbol> - Stop watching
        this.bot.onText(/\/unwatch\s+(\S+)/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleUnwatch(match[1]);
        });

        // /watchlist - Show watched symbols
        this.bot.onText(/\/watchlist$/i, (msg) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleWatchlist();
        });

        // /subscribe <symbol> - Subscribe without periodic updates (old behavior)
        this.bot.onText(/\/subscribe\s+(\S+)/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            const symbol = match[1].toUpperCase().replace('_', '_');
            this.handleSubscribe(symbol);
        });

        // /symbols - List ALL available symbols
        this.bot.onText(/\/symbols/i, (msg) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            this.handleListSymbols();
        });

        // /search <query> - Search for symbols
        this.bot.onText(/\/search\s+(.+)/i, (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) return;
            this.chatId = msg.chat.id;
            const query = match[1].trim();
            this.handleSearchSymbols(query);
        });

        console.log('📱 Telegram commands ready');
    }

    // Send help message
    async sendHelp() {
        const helpText = `
🤖 *Deriv Price Alert Bot*

*Watch Commands:*
/watch <symbol> - Live updates to Telegram (default: 5min)
/watch <symbol> <sec> - Custom interval (e.g. /watch BTC 60)
/unwatch <symbol> - Stop watching
/watchlist - Show watched symbols

*Price Commands:*
/price <symbols> - Get prices (e.g. /price BTC ETH XAU)
/prices - Show all subscribed prices

*Alert Commands:*
/alert <symbol> above <price>
/alert <symbol> below <price>
/alert <symbol> crosses <price>
/alerts - Multiple alerts at once
/list - List all alerts
/remove <id> - Remove alert
/clear - Clear triggered alerts

*Info Commands:*
/symbols - List all available indices
/search <name> - Search symbols

*Quick Aliases:*
XAU, XAG, BTC, ETH, V10, V25, V50, V75, V100

💡 Examples:
/watch XAU 30
/alert BTC above 95000
/alerts BTC above 95000, ETH below 2000, XAU crosses 2900
        `;
        await this.send(helpText, { parse_mode: 'Markdown' });
    }

    // Handle /price command - supports multiple symbols
    async handlePriceCommand(inputSymbols) {
        if (!this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        if (!inputSymbols) {
            await this.send('Usage:\n/price BTC\n/price BTC ETH XAU\n/price V75 V100');
            return;
        }

        // Split by space or comma to get multiple symbols
        const symbolList = inputSymbols.split(/[\s,]+/).filter(s => s.length > 0);
        
        // If single symbol, use quick response
        if (symbolList.length === 1) {
            await this.fetchAndSendPrice(symbolList[0]);
            return;
        }

        // Multiple symbols - fetch all
        await this.send(`📡 Fetching ${symbolList.length} prices...`);
        
        let message = '📊 *Prices*\n\n';
        let fetchedCount = 0;

        for (const inputSymbol of symbolList) {
            const symbol = this.derivClient.resolveSymbol(inputSymbol);
            const alias = this.derivClient.getAlias(symbol);
            const displayName = alias || symbol;

            // Validate symbol
            if (!this.derivClient.isValidSymbol(symbol)) {
                message += `❌ \`${inputSymbol}\` - Invalid symbol\n`;
                continue;
            }

            let price = this.derivClient.getPrice(symbol);
            
            // Auto-subscribe if not already
            if (!price) {
                try {
                    await this.derivClient.subscribe(symbol, (sym, curr, prev) => {
                        if (this.alertManager) {
                            const triggered = this.alertManager.checkAlerts(sym, curr, prev);
                            for (const alert of triggered) {
                                this.sendAlert(alert, curr);
                            }
                        }
                    });
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    price = this.derivClient.getPrice(symbol);
                } catch (error) {
                    const symbolInfo = this.derivClient.getSymbolInfo(symbol);
                    if (symbolInfo && symbolInfo.exchange_is_open === 0) {
                        message += `⏸️ \`${displayName}\` - Market closed\n`;
                    } else {
                        message += `❌ \`${displayName}\` - Failed to fetch\n`;
                    }
                    continue;
                }
            }

            if (price) {
                const priceData = this.derivClient.getPriceData(symbol);
                const change = priceData.current - priceData.previous;
                const icon = change > 0 ? '🟢' : change < 0 ? '🔴' : '⚪';
                message += `${icon} \`${displayName}\`: ${price.toFixed(3)} (${change >= 0 ? '+' : ''}${change.toFixed(3)})\n`;
                fetchedCount++;
            }
        }

        await this.send(message, { parse_mode: 'Markdown' });
    }

    // Fetch and send single price
    async fetchAndSendPrice(inputSymbol) {
        const symbol = this.derivClient.resolveSymbol(inputSymbol);
        const alias = this.derivClient.getAlias(symbol);
        const displayName = alias ? `${alias} (${symbol})` : symbol;

        let price = this.derivClient.getPrice(symbol);
        
        // If not subscribed yet, auto-subscribe
        if (!price) {
            // Validate symbol first
            if (!this.derivClient.isValidSymbol(symbol)) {
                const suggestions = this.findSimilarSymbols(inputSymbol, 3);
                let msg = `❌ Invalid symbol: ${inputSymbol}\n\n`;
                if (suggestions.length > 0) {
                    msg += `Did you mean:\n${suggestions.map(s => `• ${s.symbol}`).join('\n')}\n\n`;
                }
                msg += `Use /symbols to see all available indices.`;
                await this.send(msg);
                return;
            }
            
            await this.send(`📡 Fetching ${displayName}...`);
            try {
                await this.derivClient.subscribe(symbol, (sym, curr, prev) => {
                    if (this.alertManager) {
                        const triggered = this.alertManager.checkAlerts(sym, curr, prev);
                        for (const alert of triggered) {
                            this.sendAlert(alert, curr);
                        }
                    }
                });
                // Wait for first price
                await new Promise(resolve => setTimeout(resolve, 2000));
                price = this.derivClient.getPrice(symbol);
            } catch (error) {
                await this.send(`❌ Failed to fetch ${displayName}: ${error.message}`);
                return;
            }
        }
        
        if (price) {
            const priceData = this.derivClient.getPriceData(symbol);
            const change = priceData.current - priceData.previous;
            const icon = change > 0 ? '🟢' : change < 0 ? '🔴' : '⚪';
            await this.send(`${icon} *${displayName}*: ${price.toFixed(3)} (${change >= 0 ? '+' : ''}${change.toFixed(3)})`, { parse_mode: 'Markdown' });
        } else {
            await this.send(`❌ Unable to get price for ${displayName}`);
        }
    }

    // Handle /prices command
    async handleAllPricesCommand() {
        if (!this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const allPrices = this.derivClient.getAllPrices();
        if (!allPrices || allPrices.size === 0) {
            await this.send('No prices available yet. Add an alert or use /watch to monitor a symbol.');
            return;
        }

        let message = '📊 *Current Prices*\n\n';
        for (const [symbol, data] of allPrices) {
            const change = data.current - data.previous;
            const icon = change > 0 ? '🟢' : change < 0 ? '🔴' : '⚪';
            message += `${icon} *${symbol}*: ${data.current.toFixed(3)}\n`;
        }
        message += `\n⏰ ${new Date().toLocaleTimeString()}`;
        await this.send(message, { parse_mode: 'Markdown' });
    }

    // Handle /alert command - single symbol
    async handleAddAlert(inputSymbol, condition, price) {
        if (!this.alertManager || !this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        if (isNaN(price) || price <= 0) {
            await this.send('❌ Invalid price. Must be a positive number.');
            return;
        }

        await this.addSingleAlert(inputSymbol, condition, price);
    }

    // Add single alert with detailed response
    async addSingleAlert(inputSymbol, condition, price) {
        const symbol = this.derivClient.resolveSymbol(inputSymbol);
        const usedAlias = symbol !== inputSymbol.toUpperCase() ? inputSymbol.toUpperCase() : null;

        // Validate symbol dynamically
        if (!this.derivClient.isValidSymbol(symbol)) {
            const suggestions = this.findSimilarSymbols(inputSymbol, 3);
            let msg = `❌ Invalid symbol: ${inputSymbol}\n\n`;
            if (suggestions.length > 0) {
                msg += `Did you mean:\n${suggestions.map(s => `• ${s.symbol} - ${s.name}`).join('\n')}\n\n`;
            }
            msg += `Use /symbols or /search to find valid symbols.`;
            await this.send(msg);
            return;
        }

        // Subscribe to symbol if not already monitoring
        let currentPrice = this.derivClient.getPrice(symbol);
        if (!currentPrice) {
            const displayName = usedAlias || symbol;
            await this.send(`📡 Subscribing to ${displayName}...`);
            try {
                await this.derivClient.subscribe(symbol, (sym, curr, prev) => {
                    if (this.alertManager) {
                        const triggered = this.alertManager.checkAlerts(sym, curr, prev);
                        for (const alert of triggered) {
                            this.sendAlert(alert, curr);
                        }
                    }
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
                currentPrice = this.derivClient.getPrice(symbol);
            } catch (error) {
                await this.send(`❌ Failed to subscribe: ${error.message}`);
                return;
            }
        }

        // Add the alert
        const symbolInfo = this.derivClient.getSymbolInfo(symbol);
        const displayName = usedAlias || this.derivClient.getAlias(symbol) || symbol;
        const alert = this.alertManager.addAlert(symbol, symbolInfo?.display_name || displayName, condition, price, false);
        
        const aliasNote = usedAlias ? `\n📝 (${usedAlias} → ${symbol})` : '';
        const priceDiff = currentPrice ? (price - currentPrice) : 0;
        const distancePct = currentPrice ? ((priceDiff) / currentPrice * 100) : 0;
        const direction = condition === 'above' ? '↑' : condition === 'below' ? '↓' : '↔';
        
        let distanceStr;
        if (Math.abs(distancePct) < 0.01) {
            distanceStr = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(3)} (${distancePct.toFixed(4)}%)`;
        } else {
            distanceStr = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(3)} (${distancePct.toFixed(2)}%)`;
        }
        
        await this.send(
            `✅ *Alert Added*${aliasNote}\n\n` +
            `🔔 ${direction} *${displayName}* ${condition} *${price}*\n` +
            `📍 Current: ${currentPrice?.toFixed(3) || 'loading...'}\n` +
            `📏 Distance: ${distanceStr}\n\n` +
            `ID: #${alert.id}`,
            { parse_mode: 'Markdown' }
        );
    }

    // Handle /alerts command - multiple alerts with different conditions
    // Format: /alerts BTC above 95000, ETH below 2000, XAU crosses 2900
    async handleMultipleAlerts(input) {
        if (!this.alertManager || !this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        // Split by comma, semicolon, or newline
        const alertStrings = input.split(/[,;\n]+/).map(s => s.trim()).filter(s => s.length > 0);
        
        if (alertStrings.length === 0) {
            await this.send('Usage:\n/alerts BTC above 95000, ETH below 2000, XAU crosses 2900');
            return;
        }

        await this.send(`📡 Adding ${alertStrings.length} alerts...`);
        
        let message = '✅ *Alerts Added*\n\n';
        let addedCount = 0;
        let errors = [];

        for (const alertStr of alertStrings) {
            // Parse: SYMBOL CONDITION PRICE
            const match = alertStr.match(/^(\S+)\s+(above|below|crosses)\s+([\d.]+)$/i);
            
            if (!match) {
                errors.push(`❌ Invalid format: "${alertStr}"`);
                continue;
            }

            const inputSymbol = match[1];
            const condition = match[2].toLowerCase();
            const price = parseFloat(match[3]);

            if (isNaN(price) || price <= 0) {
                errors.push(`❌ Invalid price: "${alertStr}"`);
                continue;
            }

            const symbol = this.derivClient.resolveSymbol(inputSymbol);
            const alias = this.derivClient.getAlias(symbol);
            const displayName = alias || symbol;
            const direction = condition === 'above' ? '↑' : condition === 'below' ? '↓' : '↔';

            // Validate symbol
            if (!this.derivClient.isValidSymbol(symbol)) {
                errors.push(`❌ \`${inputSymbol}\` - Invalid symbol`);
                continue;
            }

            // Subscribe if needed
            let currentPrice = this.derivClient.getPrice(symbol);
            if (!currentPrice) {
                try {
                    await this.derivClient.subscribe(symbol, (sym, curr, prev) => {
                        if (this.alertManager) {
                            const triggered = this.alertManager.checkAlerts(sym, curr, prev);
                            for (const alert of triggered) {
                                this.sendAlert(alert, curr);
                            }
                        }
                    });
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    currentPrice = this.derivClient.getPrice(symbol);
                } catch (error) {
                    const symInfo = this.derivClient.getSymbolInfo(symbol);
                    if (symInfo && symInfo.exchange_is_open === 0) {
                        errors.push(`⏸️ \`${displayName}\` - Market closed`);
                    } else {
                        errors.push(`❌ \`${displayName}\` - Failed to subscribe`);
                    }
                    continue;
                }
            }

            // Add alert
            const symbolInfo = this.derivClient.getSymbolInfo(symbol);
            const alert = this.alertManager.addAlert(symbol, symbolInfo?.display_name || displayName, condition, price, false);
            message += `${direction} \`${displayName}\` ${condition} ${price} (#${alert.id})\n`;
            addedCount++;
        }

        if (errors.length > 0) {
            message += `\n${errors.join('\n')}\n`;
        }
        
        message += `\n✅ Added ${addedCount}/${alertStrings.length} alerts`;
        await this.send(message, { parse_mode: 'Markdown' });
    }

    // Handle /list command
    async handleListAlerts() {
        if (!this.alertManager) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const alerts = this.alertManager.getEnabledAlerts();
        if (alerts.length === 0) {
            await this.send('📋 No active alerts.\n\nUse /alert to add one:\n/alert R_10 above 5400');
            return;
        }

        let message = '📋 *Active Alerts*\n\n';
        for (const alert of alerts) {
            const status = alert.triggered ? '✅' : '⏳';
            const direction = alert.condition === 'above' ? '↑' : alert.condition === 'below' ? '↓' : '↔';
            const currentPrice = this.derivClient?.getPrice(alert.symbol);
            const priceDiff = currentPrice ? (alert.price - currentPrice) : 0;
            const distanceStr = currentPrice 
                ? `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(3)}` 
                : '?';
            
            // Use backticks for symbol to avoid underscore parsing issues
            const displaySymbol = this.derivClient?.getAlias(alert.symbol) || alert.symbol;
            message += `${status} *#${alert.id}* ${direction} \`${displaySymbol}\`\n`;
            message += `    ${alert.condition} ${alert.price} (${distanceStr})\n\n`;
        }
        message += `Use /remove <id> to delete`;
        await this.send(message, { parse_mode: 'Markdown' });
    }

    // Handle /remove command
    async handleRemoveAlert(id) {
        if (!this.alertManager) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const success = this.alertManager.removeAlert(id);
        if (success) {
            await this.send(`✅ Alert #${id} removed`);
        } else {
            await this.send(`❌ Alert #${id} not found\n\nUse /list to see all alerts`);
        }
    }

    // Handle /clear command
    async handleClearTriggered() {
        if (!this.alertManager) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const count = this.alertManager.clearTriggered();
        if (count === 0) {
            await this.send('📋 No triggered alerts to clear.\n\nUse /list to see your alerts.');
        } else {
            await this.send(`✅ Cleared ${count} triggered alert${count > 1 ? 's' : ''}`);
        }
    }

    // Find similar symbols for suggestions
    findSimilarSymbols(query, limit = 5) {
        if (!this.derivClient) return [];
        const symbols = this.derivClient.getAvailableSymbols();
        const results = [];
        const queryLower = query.toLowerCase();
        
        for (const [symbol, info] of symbols) {
            const symbolLower = symbol.toLowerCase();
            const nameLower = info.display_name.toLowerCase();
            if (symbolLower.includes(queryLower) || nameLower.includes(queryLower)) {
                results.push({ symbol, name: info.display_name });
            }
        }
        return results.slice(0, limit);
    }

    // Handle /watch command - periodic Telegram updates
    async handleWatch(inputSymbol, intervalSec = 60) {
        if (!this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        // Resolve alias to actual Deriv symbol
        const symbol = this.derivClient.resolveSymbol(inputSymbol);
        const alias = this.derivClient.getAlias(symbol);
        const displayName = alias ? `${alias} (${symbol})` : symbol;

        // Validate symbol
        if (!this.derivClient.isValidSymbol(symbol)) {
            const suggestions = this.findSimilarSymbols(inputSymbol, 3);
            let msg = `❌ Invalid symbol: ${inputSymbol}\n\n`;
            if (suggestions.length > 0) {
                msg += `Did you mean:\n${suggestions.map(s => `• ${s.symbol}`).join('\n')}\n\n`;
            }
            msg += `Use /symbols to see all available indices.`;
            await this.send(msg);
            return;
        }

        // Check if already watching
        if (this.watchlist.has(symbol)) {
            const info = this.watchlist.get(symbol);
            await this.send(`Already watching ${displayName} (updates every ${info.updateIntervalSec}s)\n\nUse /unwatch ${alias || symbol} to stop.`);
            return;
        }

        // Ensure symbol is subscribed
        if (!this.derivClient.getPrice(symbol)) {
            await this.send(`📡 Subscribing to ${displayName}...`);
            try {
                await this.derivClient.subscribe(symbol, (sym, curr, prev) => {
                    if (this.alertManager) {
                        const triggered = this.alertManager.checkAlerts(sym, curr, prev);
                        for (const alert of triggered) {
                            this.sendAlert(alert, curr);
                        }
                    }
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                await this.send(`❌ Failed to subscribe: ${error.message}`);
                return;
            }
        }

        // Start periodic updates
        const interval = setInterval(async () => {
            const price = this.derivClient.getPrice(symbol);
            if (price) {
                const priceData = this.derivClient.getPriceData(symbol);
                const watchInfo = this.watchlist.get(symbol);
                const change = price - (watchInfo?.lastPrice || price);
                const icon = change > 0 ? '🟢' : change < 0 ? '🔴' : '⚪';
                const changeStr = change !== 0 ? ` (${change >= 0 ? '+' : ''}${change.toFixed(3)})` : '';
                
                await this.send(`${icon} *${displayName}*: ${price.toFixed(3)}${changeStr}`, { parse_mode: 'Markdown' });
                
                // Update last price
                if (watchInfo) {
                    watchInfo.lastPrice = price;
                }
            }
        }, intervalSec * 1000);

        const price = this.derivClient.getPrice(symbol);
        this.watchlist.set(symbol, {
            interval,
            lastPrice: price,
            updateIntervalSec: intervalSec,
            displayName,
            alias: alias || inputSymbol.toUpperCase()
        });

        await this.send(
            `👁️ *Watching ${displayName}*\n\n` +
            `📊 Current: ${price?.toFixed(3) || 'loading...'}\n` +
            `⏱️ Updates every ${intervalSec} seconds\n\n` +
            `Use /unwatch ${alias || symbol} to stop`,
            { parse_mode: 'Markdown' }
        );
    }

    // Handle /unwatch command
    async handleUnwatch(inputSymbol) {
        const symbol = this.derivClient?.resolveSymbol(inputSymbol) || inputSymbol.toUpperCase();
        const alias = this.derivClient?.getAlias(symbol);
        const displayName = alias ? `${alias} (${symbol})` : symbol;

        if (this.watchlist.has(symbol)) {
            const info = this.watchlist.get(symbol);
            clearInterval(info.interval);
            this.watchlist.delete(symbol);
            await this.send(`✅ Stopped watching ${displayName}`);
        } else {
            await this.send(`❌ Not watching ${displayName}\n\nUse /watchlist to see watched symbols.`);
        }
    }

    // Handle /watchlist command
    async handleWatchlist() {
        if (this.watchlist.size === 0) {
            await this.send('📋 Not watching any symbols\n\nUse /watch <symbol> to start watching.');
            return;
        }

        let message = `👁️ *Watchlist* (${this.watchlist.size} symbols)\n\n`;
        
        for (const [symbol, info] of this.watchlist) {
            const price = this.derivClient?.getPrice(symbol);
            message += `• *${info.alias}*: ${price?.toFixed(3) || '...'} (every ${info.updateIntervalSec}s)\n`;
        }
        
        message += `\nUse /unwatch <symbol> to stop watching`;
        await this.send(message, { parse_mode: 'Markdown' });
    }

    // Handle /subscribe command (silent subscription, no periodic updates)
    async handleSubscribe(inputSymbol) {
        if (!this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const symbol = this.derivClient.resolveSymbol(inputSymbol);
        const alias = this.derivClient.getAlias(symbol);
        const displayName = alias ? `${alias} (${symbol})` : symbol;

        if (!this.derivClient.isValidSymbol(symbol)) {
            const suggestions = this.findSimilarSymbols(inputSymbol, 3);
            let msg = `❌ Invalid symbol: ${inputSymbol}\n\n`;
            if (suggestions.length > 0) {
                msg += `Did you mean:\n${suggestions.map(s => `• ${s.symbol}`).join('\n')}\n\n`;
            }
            msg += `Use /symbols to see all available indices.`;
            await this.send(msg);
            return;
        }

        if (this.derivClient.getPrice(symbol)) {
            const price = this.derivClient.getPrice(symbol);
            await this.send(`Already subscribed to ${displayName}\n\n📊 Price: ${price.toFixed(3)}`);
            return;
        }

        try {
            await this.send(`📡 Subscribing to ${displayName}...`);
            await this.derivClient.subscribe(symbol, (sym, curr, prev) => {
                if (this.alertManager) {
                    const triggered = this.alertManager.checkAlerts(sym, curr, prev);
                    for (const alert of triggered) {
                        this.sendAlert(alert, curr);
                    }
                }
            });
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            const price = this.derivClient.getPrice(symbol);
            
            if (price) {
                await this.send(`✅ Subscribed to *${displayName}*\n\n📊 Price: ${price.toFixed(3)}`, { parse_mode: 'Markdown' });
            } else {
                await this.send(`✅ Subscribed to ${displayName}`);
            }
        } catch (error) {
            await this.send(`❌ Failed: ${error.message}`);
        }
    }

    // Handle /symbols command - show ALL symbols with names
    async handleListSymbols() {
        if (!this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const grouped = this.derivClient.getSymbolsBySubmarket();
        const submarkets = Object.keys(grouped).sort();
        
        if (submarkets.length === 0) {
            await this.send('No symbols loaded yet. Please wait...');
            return;
        }

        // Reverse alias map to show short names
        const reverseAlias = {
            'cryBTCUSD': 'BTC',
            'cryETHUSD': 'ETH',
            'frxXAUUSD': 'XAU',
            'frxXAGUSD': 'XAG'
        };

        // Build full message with all symbols
        let message = `📊 *ALL Available Symbols*\n\n`;

        // Show custom shortcuts first
        message += `*⭐ Quick Symbols (shortcuts):*\n`;
        message += `• \`BTC\` - Bitcoin/USD\n`;
        message += `• \`ETH\` - Ethereum/USD\n`;
        message += `• \`XAU\` - Gold/USD\n`;
        message += `• \`XAG\` - Silver/USD\n\n`;

        for (const submarket of submarkets) {
            const symbols = grouped[submarket];
            // Capitalize submarket name
            const submarketTitle = submarket.charAt(0).toUpperCase() + submarket.slice(1);
            message += `*${submarketTitle}:*\n`;
            for (const s of symbols) {
                // Use short alias if available
                const displaySymbol = reverseAlias[s.symbol] || s.symbol;
                const namePart = s.name ? ` - ${s.name}` : '';
                message += `• \`${displaySymbol}\`${namePart}\n`;
            }
            message += `\n`;
        }

        message += `\n💡 Use: /alert <symbol> above/below <price>`;
        
        // Telegram has 4096 char limit, split if needed
        if (message.length > 4000) {
            // Split into multiple messages
            const parts = this.splitMessage(message, 4000);
            for (const part of parts) {
                await this.send(part, { parse_mode: 'Markdown' });
            }
        } else {
            await this.send(message, { parse_mode: 'Markdown' });
        }
    }

    // Split long message into parts
    splitMessage(message, maxLength) {
        const parts = [];
        let current = '';
        const lines = message.split('\n');
        
        for (const line of lines) {
            if ((current + line + '\n').length > maxLength) {
                parts.push(current);
                current = line + '\n';
            } else {
                current += line + '\n';
            }
        }
        if (current) parts.push(current);
        return parts;
    }

    // Handle /search command
    async handleSearchSymbols(query) {
        if (!this.derivClient) {
            await this.send('❌ Bot not fully initialized. Please wait...');
            return;
        }

        const results = this.findSimilarSymbols(query, 15);
        
        if (results.length === 0) {
            await this.send(`🔍 No symbols found matching "${query}"\n\nTry /symbols to browse all.`);
            return;
        }

        let message = `🔍 *Search Results for "${query}"*\n\n`;
        for (const s of results) {
            message += `• \`${s.symbol}\` - ${s.name}\n`;
        }
        message += `\n💡 Use /alert ${results[0].symbol} above <price>`;
        
        await this.send(message, { parse_mode: 'Markdown' });
    }

    // Send message helper
    async send(text, options = {}) {
        if (this.enabled && this.bot) {
            try {
                await this.bot.sendMessage(this.chatId, text, options);
            } catch (error) {
                console.error('Telegram send error:', error.message);
            }
        }
        // Also log to console (without markdown)
        console.log(text.replace(/\*/g, '').replace(/\\_/g, '_'));
    }

    // Send price alert notification
    async sendAlert(alert, currentPrice) {
        const emoji = alert.condition === 'above' ? '📈' : alert.condition === 'below' ? '📉' : '↔️';
        const conditionText = alert.condition.toUpperCase();
        
        const message = `
🚨 *PRICE ALERT* 🚨

${emoji} *${alert.symbol}*

✅ Price ${conditionText} ${alert.price}
📍 Current: *${currentPrice.toFixed(3)}*

⏰ ${new Date().toLocaleString()}
        `.trim();

        // Log to console
        console.log('\n' + '🔔'.repeat(20));
        console.log(message.replace(/\*/g, ''));
        console.log('🔔'.repeat(20) + '\n');

        // Send to Telegram
        if (this.enabled && this.bot) {
            try {
                await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
                console.log('📤 Alert sent to Telegram');
            } catch (error) {
                console.error('Failed to send alert:', error.message);
            }
        }
    }

    // Send startup message
    async sendStartupMessage(alerts) {
        const enabledAlerts = alerts.filter(a => a.enabled && !a.triggered);
        
        let message;
        
        if (enabledAlerts.length > 0) {
            const alertsList = enabledAlerts.map(a => {
                const dir = a.condition === 'above' ? '↑' : a.condition === 'below' ? '↓' : '↔';
                const displaySymbol = this.derivClient?.getAlias(a.symbol) || a.symbol;
                return `${dir} \`${displaySymbol}\` ${a.condition} ${a.price}`;
            }).join('\n');
            
            message = `
🟢 *Price Alert Bot Started*

📋 ${enabledAlerts.length} Active Alerts:
${alertsList}

💡 Send /help for commands
⏰ ${new Date().toLocaleString()}
            `.trim();
        } else {
            message = `
🟢 *Price Alert Bot Ready!*

No alerts configured yet.

Quick Start:
1️⃣ /symbols - See all available symbols
2️⃣ /alert <symbol> above <price>
3️⃣ /list - View your alerts

Examples:
• /alert BTC above 95000
• /alert XAU below 2900
• /alert V75 crosses 5000

Quick Symbols:
🪙 BTC, ETH (Crypto)
🥇 XAU, XAG (Metals)
📈 V10, V25, V50, V75, V100 (Synthetics)

💡 Send /help for all commands
⏰ ${new Date().toLocaleString()}
            `.trim();
        }

        console.log('\n' + message.replace(/\*/g, '').replace(/`/g, '') + '\n');

        if (this.enabled && this.bot) {
            try {
                await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Failed to send startup message:', error.message);
            }
        }
    }
}

module.exports = TelegramNotifier;
