/**
 * Alert Manager
 * Manages price alerts with Redis persistence (falls back to file if Redis unavailable)
 */

const fs = require('fs');
const path = require('path');

class AlertManager {
    constructor(configPath, redisClient = null) {
        this.configPath = configPath;
        this.redis = redisClient;
        this.redisKey = 'deriv:alerts';
        this.alerts = [];
        this.useRedis = false;
    }

    // Initialize storage (call after construction)
    async init() {
        if (this.redis) {
            try {
                await this.redis.ping();
                this.useRedis = true;
                console.log('✅ Using Redis for alert storage');
                await this.loadAlertsFromRedis();
            } catch (error) {
                console.log('⚠️ Redis unavailable, using file storage');
                this.useRedis = false;
                this.ensureConfigFile();
                this.loadAlertsFromFile();
            }
        } else {
            console.log('📁 Using file storage for alerts');
            this.ensureConfigFile();
            this.loadAlertsFromFile();
        }
    }

    // Load alerts from Redis
    async loadAlertsFromRedis() {
        try {
            const data = await this.redis.get(this.redisKey);
            if (data) {
                this.alerts = JSON.parse(data);
            } else {
                this.alerts = [];
            }
            console.log(`📋 Loaded ${this.alerts.length} alerts from Redis`);
        } catch (error) {
            console.error('Failed to load alerts from Redis:', error.message);
            this.alerts = [];
        }
    }

    // Save alerts to Redis
    async saveAlertsToRedis() {
        try {
            await this.redis.set(this.redisKey, JSON.stringify(this.alerts));
        } catch (error) {
            console.error('Failed to save alerts to Redis:', error.message);
        }
    }

    // Create config file if it doesn't exist
    ensureConfigFile() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            if (!fs.existsSync(this.configPath)) {
                fs.writeFileSync(this.configPath, JSON.stringify({ alerts: [] }, null, 2));
                console.log(`📁 Created new alerts file: ${this.configPath}`);
            }
        } catch (error) {
            console.error('Failed to create config file:', error.message);
        }
    }

    // Load alerts from file
    loadAlertsFromFile() {
        try {
            const data = fs.readFileSync(this.configPath, 'utf8');
            const config = JSON.parse(data);
            this.alerts = config.alerts || [];
            console.log(`📋 Loaded ${this.alerts.length} alerts from file`);
        } catch (error) {
            console.error('Failed to load alerts:', error.message);
            this.alerts = [];
        }
    }

    // Save alerts to file
    saveAlertsToFile() {
        try {
            this.ensureConfigFile();
            const config = { alerts: this.alerts };
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
        } catch (error) {
            console.error('Failed to save alerts:', error.message);
        }
    }

    // Save alerts (auto-selects storage)
    saveAlerts() {
        if (this.useRedis) {
            this.saveAlertsToRedis();
        } else {
            this.saveAlertsToFile();
        }
    }

    getEnabledAlerts() {
        return this.alerts.filter(a => a.enabled);
    }

    getAllAlerts() {
        return this.alerts;
    }

    getActiveSymbols() {
        const symbols = new Set();
        this.getEnabledAlerts().forEach(a => symbols.add(a.symbol));
        return Array.from(symbols);
    }

    checkAlerts(symbol, currentPrice, previousPrice) {
        const triggeredAlerts = [];

        for (const alert of this.alerts) {
            if (!alert.enabled || alert.symbol !== symbol) continue;
            if (alert.triggered && !alert.repeat) continue;

            let triggered = false;

            switch (alert.condition) {
                case 'above':
                    // Trigger when price goes above target
                    if (currentPrice >= alert.price && previousPrice < alert.price) {
                        triggered = true;
                    }
                    // Also trigger if price is already above and wasn't checked before
                    else if (currentPrice >= alert.price && !alert.triggered) {
                        triggered = true;
                    }
                    break;

                case 'below':
                    // Trigger when price goes below target
                    if (currentPrice <= alert.price && previousPrice > alert.price) {
                        triggered = true;
                    }
                    // Also trigger if price is already below and wasn't checked before
                    else if (currentPrice <= alert.price && !alert.triggered) {
                        triggered = true;
                    }
                    break;

                case 'crosses':
                    // Trigger when price crosses target in either direction
                    if ((currentPrice >= alert.price && previousPrice < alert.price) ||
                        (currentPrice <= alert.price && previousPrice > alert.price)) {
                        triggered = true;
                    }
                    break;
            }

            if (triggered) {
                alert.triggered = true;
                triggeredAlerts.push(alert);
                
                if (!alert.repeat) {
                    this.saveAlerts(); // Save state so it doesn't trigger again on restart
                }
            }
        }

        return triggeredAlerts;
    }

    addAlert(symbol, name, condition, price, repeat = false) {
        const newId = Math.max(...this.alerts.map(a => a.id), 0) + 1;
        
        const newAlert = {
            id: newId,
            symbol,
            name,
            condition,
            price,
            enabled: true,
            repeat,
            triggered: false
        };

        this.alerts.push(newAlert);
        this.saveAlerts();
        
        console.log(`✅ Added alert: ${symbol} ${condition} ${price}`);
        return newAlert;
    }

    removeAlert(id) {
        const index = this.alerts.findIndex(a => a.id === id);
        if (index !== -1) {
            const removed = this.alerts.splice(index, 1)[0];
            this.renumberAlerts();
            console.log(`🗑️ Removed alert: ${removed.symbol} ${removed.condition} ${removed.price}`);
            return true;
        }
        return false;
    }

    // Remove ALL alerts
    removeAllAlerts() {
        const count = this.alerts.length;
        this.alerts = [];
        this.saveAlerts();
        console.log(`🗑️ Removed all ${count} alerts`);
        return count;
    }

    // Renumber all alerts sequentially starting from 1
    renumberAlerts() {
        this.alerts.forEach((alert, index) => {
            alert.id = index + 1;
        });
        this.saveAlerts();
    }

    enableAlert(id) {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.enabled = true;
            alert.triggered = false; // Reset trigger state
            this.saveAlerts();
            return true;
        }
        return false;
    }

    disableAlert(id) {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.enabled = false;
            this.saveAlerts();
            return true;
        }
        return false;
    }

    resetAlert(id) {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.triggered = false;
            this.saveAlerts();
            return true;
        }
        return false;
    }

    // Clear all triggered (non-repeating) alerts
    clearTriggered() {
        const triggeredAlerts = this.alerts.filter(a => a.triggered && !a.repeat);
        const count = triggeredAlerts.length;
        
        if (count > 0) {
            // Remove triggered alerts
            this.alerts = this.alerts.filter(a => !a.triggered || a.repeat);
            this.renumberAlerts();
            console.log(`🗑️ Cleared ${count} triggered alert${count > 1 ? 's' : ''}`);
        }
        return count;
    }

    listAlerts() {
        console.log('\n📋 Configured Alerts:');
        console.log('─'.repeat(60));
        
        for (const alert of this.alerts) {
            const status = !alert.enabled ? '⚫ DISABLED' : 
                           alert.triggered ? '✅ TRIGGERED' : '🟢 ACTIVE';
            const repeatIcon = alert.repeat ? '🔄' : '1️⃣';
            
            console.log(`${status} ${repeatIcon} [${alert.id}] ${alert.symbol}: ${alert.condition.toUpperCase()} ${alert.price}`);
        }
        
        console.log('─'.repeat(60) + '\n');
    }
}

module.exports = AlertManager;
