/**
 * Deriv Price Alert System
 * 
 * Monitors synthetic indices and sends Telegram alerts when price targets are hit
 * 
 * Usage:
 *   npm start              - Start the alert system
 *   npm start -- --list    - List all configured alerts
 *   npm start -- --add     - Add a new alert interactively
 */

require('dotenv').config();

const path = require('path');
const readline = require('readline');

const DerivClient = require('./deriv-client');
const TelegramNotifier = require('./telegram-bot');
const AlertManager = require('./alert-manager');

// Configuration
const CONFIG = {
    appId: process.env.DERIV_APP_ID || '1089', // Default demo app ID
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    alertsConfig: path.join(__dirname, '../config/alerts.json')
};

// Initialize components
const derivClient = new DerivClient(CONFIG.appId);
const telegram = new TelegramNotifier(CONFIG.telegramToken, CONFIG.telegramChatId);
const alertManager = new AlertManager(CONFIG.alertsConfig);

// Price tick handler
function handlePriceTick(symbol, currentPrice, previousPrice) {
    // Check all alerts for this symbol
    const triggeredAlerts = alertManager.checkAlerts(symbol, currentPrice, previousPrice);
    
    // Send notifications for triggered alerts
    for (const alert of triggeredAlerts) {
        telegram.sendAlert(alert, currentPrice);
    }
}

// Display current prices periodically
function displayPrices() {
    const symbols = alertManager.getActiveSymbols();
    
    console.log('\n' + '─'.repeat(50));
    console.log('📊 CURRENT PRICES - ' + new Date().toLocaleTimeString());
    console.log('─'.repeat(50));
    
    for (const symbol of symbols) {
        const priceData = derivClient.getPriceData(symbol);
        if (priceData) {
            const change = priceData.current - priceData.previous;
            const changeIcon = change > 0 ? '🟢' : change < 0 ? '🔴' : '⚪';
            console.log(`${changeIcon} ${symbol}: ${priceData.current.toFixed(3)} (${change >= 0 ? '+' : ''}${change.toFixed(3)})`);
        }
    }
    
    // Show active alerts status
    const activeAlerts = alertManager.getEnabledAlerts().filter(a => !a.triggered);
    if (activeAlerts.length > 0) {
        console.log('─'.repeat(50));
        console.log('🔔 PENDING ALERTS:');
        for (const alert of activeAlerts) {
            const price = derivClient.getPrice(alert.symbol);
            const priceDiff = price ? (alert.price - price) : 0;
            const direction = alert.condition === 'above' ? '↑' : alert.condition === 'below' ? '↓' : '↔';
            const distanceStr = price ? `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(3)}` : '?';
            console.log(`   ${direction} ${alert.symbol} ${alert.condition} ${alert.price} (${distanceStr} away)`);
        }
    }
    
    console.log('─'.repeat(50) + '\n');
}

// Main function
async function main() {
    const args = process.argv.slice(2);
    
    // Handle command line arguments
    if (args.includes('--list')) {
        alertManager.listAlerts();
        process.exit(0);
    }
    
    if (args.includes('--add')) {
        await addAlertInteractive();
        process.exit(0);
    }

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🔔 DERIV PRICE ALERT SYSTEM (Interactive)          ║
╠══════════════════════════════════════════════════════════════╣
║  Send commands via Telegram to manage alerts                 ║
║  Type /help in Telegram for available commands               ║
╚══════════════════════════════════════════════════════════════╝
    `);

    // Connect Telegram bot to other components for interactive commands
    telegram.setComponents(alertManager, derivClient);

    // Show configured alerts
    alertManager.listAlerts();

    // Get unique symbols to monitor
    const symbols = alertManager.getActiveSymbols();
    
    if (symbols.length === 0) {
        console.log('⚠️ No pre-configured alerts. Use Telegram /alert command to add alerts.');
        console.log('   Example: /alert R_10 above 5400');
    }

    try {
        // Connect to Deriv
        await derivClient.connect();

        // Fetch all available symbols (synthetics, crypto, commodities)
        console.log('\n📋 Fetching available symbols...');
        await derivClient.fetchActiveSymbols();
        const availableSymbols = derivClient.getAvailableSymbols();
        console.log(`✅ ${availableSymbols.size} symbols available (Synthetics, Crypto, Commodities)\n`);

        // Subscribe to symbols with existing alerts
        if (symbols.length > 0) {
            console.log(`📡 Subscribing to ${symbols.length} symbols: ${symbols.join(', ')}\n`);
            for (const symbol of symbols) {
                if (derivClient.isValidSymbol(symbol)) {
                    await derivClient.subscribe(symbol, handlePriceTick);
                } else {
                    console.log(`⚠️ Skipping invalid symbol: ${symbol}`);
                }
            }
        }

        // Send startup notification
        await telegram.sendStartupMessage(alertManager.getEnabledAlerts());

        // Display prices every 30 seconds
        setInterval(displayPrices, 30000);
        
        // Initial display after 5 seconds (to get some data first)
        setTimeout(displayPrices, 5000);

        console.log('\n✅ Alert system running. Press Ctrl+C to stop.\n');

    } catch (error) {
        console.error('Failed to start:', error.message);
        process.exit(1);
    }
}

// Interactive alert addition
async function addAlertInteractive() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    console.log('\n📝 ADD NEW PRICE ALERT\n');

    try {
        // Load available symbols
        const configData = require('../config/alerts.json');
        const availableSymbols = configData.symbols;

        console.log('Available symbols:');
        availableSymbols.forEach((s, i) => console.log(`  ${i + 1}. ${s.id} - ${s.name}`));
        
        const symbolIndex = parseInt(await question('\nSelect symbol number: ')) - 1;
        const selectedSymbol = availableSymbols[symbolIndex];
        
        if (!selectedSymbol) {
            console.log('Invalid selection');
            rl.close();
            return;
        }

        console.log('\nConditions:');
        console.log('  1. above - Alert when price goes ABOVE target');
        console.log('  2. below - Alert when price goes BELOW target');
        console.log('  3. crosses - Alert when price CROSSES target (either direction)');
        
        const conditionNum = await question('\nSelect condition (1/2/3): ');
        const conditions = ['above', 'below', 'crosses'];
        const condition = conditions[parseInt(conditionNum) - 1];
        
        if (!condition) {
            console.log('Invalid selection');
            rl.close();
            return;
        }

        const price = parseFloat(await question('\nEnter target price: '));
        
        if (isNaN(price) || price <= 0) {
            console.log('Invalid price');
            rl.close();
            return;
        }

        const repeatAnswer = await question('\nRepeat alert? (y/n): ');
        const repeat = repeatAnswer.toLowerCase() === 'y';

        // Add the alert
        alertManager.addAlert(
            selectedSymbol.id,
            selectedSymbol.name,
            condition,
            price,
            repeat
        );

        console.log('\n✅ Alert added successfully!\n');
        alertManager.listAlerts();

    } finally {
        rl.close();
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down...');
    derivClient.disconnect();
    process.exit(0);
});

// Run
main().catch(console.error);
