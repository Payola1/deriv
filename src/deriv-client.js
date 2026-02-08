/**
 * Deriv WebSocket Client
 * Connects to Deriv API and subscribes to tick streams
 */

const WebSocket = require('ws');

// Symbol aliases - user-friendly names mapped to Deriv API symbols
const SYMBOL_ALIASES = {
    // Crypto
    'BTC': 'cryBTCUSD',
    'BTCUSD': 'cryBTCUSD',
    'BITCOIN': 'cryBTCUSD',
    'ETH': 'cryETHUSD',
    'ETHUSD': 'cryETHUSD',
    'ETHEREUM': 'cryETHUSD',
    
    // Metals
    'XAU': 'frxXAUUSD',
    'XAUUSD': 'frxXAUUSD',
    'GOLD': 'frxXAUUSD',
    'XAG': 'frxXAGUSD',
    'XAGUSD': 'frxXAGUSD',
    'SILVER': 'frxXAGUSD',
    'XPT': 'frxXPTUSD',
    'PLATINUM': 'frxXPTUSD',
    'XPD': 'frxXPDUSD',
    'PALLADIUM': 'frxXPDUSD',
    
    // Common volatility shortcuts
    'V10': 'R_10',
    'V25': 'R_25',
    'V50': 'R_50',
    'V75': 'R_75',
    'V100': 'R_100',
    'VOL10': 'R_10',
    'VOL25': 'R_25',
    'VOL50': 'R_50',
    'VOL75': 'R_75',
    'VOL100': 'R_100',
};

class DerivClient {
    constructor(appId) {
        this.appId = appId;
        this.ws = null;
        this.subscriptions = new Map(); // symbol -> subscription_id
        this.callbacks = new Map(); // symbol -> callback function
        this.prices = new Map(); // symbol -> { current, previous }
        this.activeSymbols = new Map(); // symbol -> { display_name, market, submarket }
        this.symbolAliases = SYMBOL_ALIASES;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reqId = 0;
    }

    // Resolve alias to actual Deriv symbol
    resolveSymbol(input) {
        const upper = input.toUpperCase();
        // Check alias first
        if (this.symbolAliases[upper]) {
            return this.symbolAliases[upper];
        }
        // Check if it's a valid active symbol (case-insensitive)
        for (const symbol of this.activeSymbols.keys()) {
            if (symbol.toUpperCase() === upper) {
                return symbol;
            }
        }
        return input;
    }

    // Get alias for a Deriv symbol (reverse lookup)
    getAlias(derivSymbol) {
        for (const [alias, symbol] of Object.entries(this.symbolAliases)) {
            if (symbol === derivSymbol && alias.length <= 4) {
                return alias;
            }
        }
        return null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
            
            console.log('🔌 Connecting to Deriv API...');
            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                console.log('✅ Connected to Deriv API');
                this.connected = true;
                this.reconnectAttempts = 0;
                this._startPing();
                resolve();
            });

            this.ws.on('message', (data) => {
                this._handleMessage(JSON.parse(data.toString()));
            });

            this.ws.on('close', () => {
                console.log('❌ Disconnected from Deriv API');
                this.connected = false;
                this._stopPing();
                this._attemptReconnect();
            });

            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error.message);
                reject(error);
            });
        });
    }

    _handleMessage(data) {
        if (data.msg_type === 'tick' && data.tick) {
            const tick = data.tick;
            const symbol = tick.symbol;
            const price = tick.quote;
            
            if (!symbol || price === undefined) return;
            
            // Store previous price for "crosses" condition
            const prevData = this.prices.get(symbol) || { current: price, previous: price };
            this.prices.set(symbol, {
                previous: prevData.current,
                current: price
            });

            // Call registered callback
            const callback = this.callbacks.get(symbol);
            if (callback) {
                callback(symbol, price, prevData.current);
            }
        } else if (data.msg_type === 'ping') {
            // Ping response received
        } else if (data.error) {
            console.error(`API Error: ${data.error.message}`);
        }
    }

    async subscribe(symbol, callback) {
        if (this.subscriptions.has(symbol)) {
            console.log(`Already subscribed to ${symbol}`);
            this.callbacks.set(symbol, callback);
            return;
        }

        return new Promise((resolve, reject) => {
            const reqId = ++this.reqId;
            
            const messageHandler = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.req_id === reqId) {
                    if (msg.error) {
                        reject(new Error(msg.error.message));
                    } else if (msg.subscription) {
                        this.subscriptions.set(symbol, msg.subscription.id);
                        this.callbacks.set(symbol, callback);
                        console.log(`📊 Subscribed to ${symbol}`);
                        resolve();
                    }
                    this.ws.off('message', messageHandler);
                }
            };

            this.ws.on('message', messageHandler);

            this.ws.send(JSON.stringify({
                ticks: symbol,
                subscribe: 1,
                req_id: reqId
            }));
        });
    }

    async unsubscribe(symbol) {
        const subscriptionId = this.subscriptions.get(symbol);
        if (!subscriptionId) return;

        this.ws.send(JSON.stringify({
            forget: subscriptionId
        }));

        this.subscriptions.delete(symbol);
        this.callbacks.delete(symbol);
        console.log(`🔕 Unsubscribed from ${symbol}`);
    }

    getPrice(symbol) {
        return this.prices.get(symbol)?.current || null;
    }

    getPriceData(symbol) {
        return this.prices.get(symbol) || null;
    }

    getAllPrices() {
        return this.prices;
    }

    // Fetch all active synthetic indices from Deriv API
    async fetchActiveSymbols() {
        return new Promise((resolve, reject) => {
            const reqId = ++this.reqId;
            
            const messageHandler = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.req_id === reqId) {
                    this.ws.off('message', messageHandler);
                    
                    if (msg.error) {
                        reject(new Error(msg.error.message));
                        return;
                    }
                    
                    if (msg.active_symbols) {
                        // Include synthetic indices, crypto, and commodities
                        const allowedMarkets = ['synthetic_index', 'cryptocurrency', 'commodities'];
                        const filtered = msg.active_symbols.filter(s => 
                            allowedMarkets.includes(s.market)
                        );
                        
                        // Store symbols with their info
                        this.activeSymbols.clear();
                        for (const sym of filtered) {
                            this.activeSymbols.set(sym.symbol, {
                                symbol: sym.symbol,
                                display_name: sym.display_name,
                                market: sym.market,
                                submarket: sym.submarket,
                                submarket_display_name: sym.submarket_display_name || sym.market,
                                exchange_is_open: sym.exchange_is_open
                            });
                        }
                        
                        console.log(`📋 Loaded ${this.activeSymbols.size} tradeable symbols`);
                        resolve(this.activeSymbols);
                    }
                }
            };

            this.ws.on('message', messageHandler);

            this.ws.send(JSON.stringify({
                active_symbols: 'brief',
                product_type: 'basic',
                req_id: reqId
            }));
        });
    }

    // Get all available synthetic symbols
    getAvailableSymbols() {
        return this.activeSymbols;
    }

    // Check if symbol is valid
    isValidSymbol(symbol) {
        return this.activeSymbols.has(symbol);
    }

    // Get symbol info
    getSymbolInfo(symbol) {
        return this.activeSymbols.get(symbol);
    }

    // Get symbols grouped by submarket
    getSymbolsBySubmarket() {
        const grouped = {};
        for (const [symbol, info] of this.activeSymbols) {
            const submarket = info.submarket_display_name || 'Other';
            if (!grouped[submarket]) {
                grouped[submarket] = [];
            }
            grouped[submarket].push({ symbol, name: info.display_name });
        }
        return grouped;
    }

    _startPing() {
        this.pingInterval = setInterval(() => {
            if (this.connected) {
                this.ws.send(JSON.stringify({ ping: 1 }));
            }
        }, 30000);
    }

    _stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
    }

    async _attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            process.exit(1);
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        
        console.log(`Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})...`);
        
        setTimeout(async () => {
            try {
                await this.connect();
                // Re-subscribe to all symbols
                for (const [symbol, callback] of this.callbacks) {
                    this.subscriptions.delete(symbol);
                    await this.subscribe(symbol, callback);
                }
            } catch (error) {
                console.error('Reconnection failed:', error.message);
            }
        }, delay);
    }

    disconnect() {
        this._stopPing();
        if (this.ws) {
            this.ws.close();
        }
    }
}

module.exports = DerivClient;
