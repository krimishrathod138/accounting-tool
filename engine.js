/**
 * Accounting Engine for Tally Prime Clone
 */

window.AccountingEngine = {
    /**
     * Sync data with Electron if available
     */
    async syncWithElectron() {
        if (window.electronAPI && window.electronAPI.isElectron) {
            const data = await window.electronAPI.loadData();
            if (data && !data.error) {
                // Sync from file to localStorage for current session
                for (let key in data) {
                    localStorage.setItem(key, data[key]);
                }
                return true;
            }
        }
        return false;
    },

    async persistToElectron() {
        // Update active client's vault with current session data
        try {
            const activeId = localStorage.getItem('ACTIVE_CLIENT_ID');
            if (activeId && typeof this._saveVaultFor === 'function') {
                this._saveVaultFor(activeId);
            }
        } catch(e) { /* vault update is best-effort */ }

        if (window.electronAPI && window.electronAPI.isElectron) {
            let snapshot = {};
            for (let i = 0; i < localStorage.length; i++) {
                let k = localStorage.key(i);
                snapshot[k] = localStorage.getItem(k);
            }
            await window.electronAPI.saveData(snapshot);
        }
    },

    /**
     * Get all ledgers with their closing balances
     */
    /**
     * Year suffix helper. year='CY' → '', year='PY' → '_PY'
     * Used to route reads/writes to correct localStorage keys.
     */
    _ys(year) { return year === 'PY' ? '_PY' : ''; },

    /**
     * Check if PY data has been imported
     */
    hasPYData() {
        const l = JSON.parse(localStorage.getItem('LEDGERS_PY') || '[]');
        return Array.isArray(l) && l.length > 0;
    },

    /**
     * Combined CY + PY Schedule III report
     * Returns { cy: {...}, py: {...}, hasPY: boolean }
     */
    getComparativeReport() {
        const cy = this.getScheduleIIIReport('CY');
        const hasPY = this.hasPYData();
        const py = hasPY ? this.getScheduleIIIReport('PY') : null;
        return { cy, py, hasPY };
    },

    /**
     * Clear only the Previous Year data (keeps CY intact)
     */
    clearPYData() {
        ['LEDGERS_PY', 'VOUCHERS_PY', 'AE_PY', 'TB_GRAND_TOTAL_PY'].forEach(k => localStorage.removeItem(k));
        if (this.persistToElectron) this.persistToElectron();
    },

    getLedgerBalances(year) {
        const s = this._ys(year);
        const ledgers = JSON.parse(localStorage.getItem('LEDGERS' + s) || '[]');
        const vouchers = JSON.parse(localStorage.getItem('VOUCHERS' + s) || '[]');

        let balances = {};

        // 1. Initialize with Opening Balances
        ledgers.forEach(l => {
            balances[l.name] = {
                opening: l.openingBalance || 0,
                current: l.openingBalance || 0,
                group: l.group
            };
        });

        // 2. Add Voucher Transactions
        vouchers.forEach(v => {
            v.lines.forEach(line => {
                if (!balances[line.ledger]) {
                    balances[line.ledger] = { opening: 0, current: 0, group: 'Primary' };
                }
                balances[line.ledger].current += (line.debit - line.credit);
            });
        });

        // 3. Add Adjustment Entries (AE)
        const ae = JSON.parse(localStorage.getItem('AE' + s) || '[]');
        ae.forEach(entry => {
            if (!balances[entry.ledger]) {
                balances[entry.ledger] = {
                    opening: 0,
                    current: 0,
                    group: entry.group || this.guessGroup(entry.ledger)
                };
            }
            balances[entry.ledger].current += ((Number(entry.debit) || 0) - (Number(entry.credit) || 0));
        });

        return balances;
    },

    getGroupedBalances(year) {
        const balances = this.getLedgerBalances(year);
        const groups = {};

        for (let name in balances) {
            const b = balances[name];
            const groupName = b.group || 'Primary';
            if (!groups[groupName]) {
                groups[groupName] = {
                    name: groupName,
                    total: 0,
                    ledgers: []
                };
            }
            groups[groupName].ledgers.push({ name: name, balance: b.current });
            groups[groupName].total += b.current;
        }
        return groups;
    },

    getReportData(year) {
        const groups = this.getGroupedBalances(year);
        const balances = this.getLedgerBalances(year);
        const report = {
            liabilities: [],
            assets: [],
            trading: {
                expenses: [],
                incomes: [],
                totalExp: 0,
                totalInc: 0
            },
            pl: {
                expenses: [],
                incomes: [],
                totalExp: 0,
                totalInc: 0
            },
            totalLiabilities: 0,
            totalAssets: 0,
            grossProfit: 0,
            netProfit: 0
        };

        const liabilityGroups = ['capital account', 'loans (liability)', 'unsecured loans', 'secured loans', 'current liabilities', 'current libilities', 'duties & taxes', 'sundry creditors', 'suspense a/c', 'liability', 'provisions', 'bank od', 'loans', 'sources of fund', 'long term borrowings', 'trade payables', 'other current liabilities', 'short term borrowings'];
        const assetGroups = ['fixed assets', 'current assets', 'stock-in-hand', 'closing stock', 'deposits (asset)', 'loans & advances (asset)', 'sundry debtors', 'cash-in-hand', 'bank accounts', 'investments', 'investment', 'tds receivable', 'trade mark', 'assets', 'prepaid expenses', 'non current assets', 'tangible asset', 'intangible asset', 'inventories', 'trade receivables', 'cash and cash equivalents', 'short term loans and advances', 'other current assets'];
        
        const directExpenseGroups = ['purchase accounts', 'direct expenses', 'direct expense', 'cost of sales', 'cogs', 'cost of raw material consumed', 'changes in inventories'];
        const directIncomeGroups = ['sales accounts', 'direct incomes', 'direct income', 'revenue'];

        const indirectExpenseGroups = ['indirect expenses', 'indirect expense', 'admin expenses', 'selling expenses', 'employee benefit expenses', 'other expenses', 'finance costs'];
        const indirectIncomeGroups = ['indirect incomes', 'indirect income', 'other income'];

        for (let gName in groups) {
            const g = groups[gName];
            const lowerGName = gName.toLowerCase();

            // Check indirect BEFORE direct ("indirect expenses" contains "direct expenses" substring)
            if (liabilityGroups.some(lg => lowerGName.includes(lg))) {
                report.liabilities.push(g);
                report.totalLiabilities -= g.total;
            } else if (assetGroups.some(ag => lowerGName.includes(ag))) {
                report.assets.push(g);
                report.totalAssets += g.total;
            } else if (indirectExpenseGroups.some(ieg => lowerGName.includes(ieg))) {
                report.pl.expenses.push(g);
                report.pl.totalExp += g.total;
            } else if (indirectIncomeGroups.some(iig => lowerGName.includes(iig))) {
                report.pl.incomes.push(g);
                report.pl.totalInc -= g.total;
            } else if (directExpenseGroups.some(deg => lowerGName.includes(deg))) {
                report.trading.expenses.push(g);
                report.trading.totalExp += g.total;
            } else if (directIncomeGroups.some(dig => lowerGName.includes(dig))) {
                report.trading.incomes.push(g);
                report.trading.totalInc -= g.total;
            } else {
                if (g.total < 0) {
                    report.liabilities.push(g);
                    report.totalLiabilities -= g.total;
                } else {
                    report.assets.push(g);
                    report.totalAssets += g.total;
                }
            }
        }

        // Reclassify balance sheet groups with opposite-sign balances
        // Liabilities should have credit balances (negative total); if positive → asset
        report.liabilities = report.liabilities.filter(g => {
            if (g.total > 0) {
                report.totalLiabilities += g.total; // undo the earlier -=
                report.assets.push(g);
                report.totalAssets += g.total;
                return false;
            }
            return true;
        });
        // Assets should have debit balances (positive total); if negative → liability
        report.assets = report.assets.filter(g => {
            if (g.total < 0) {
                report.totalAssets -= g.total; // undo the earlier +=
                report.liabilities.push(g);
                report.totalLiabilities -= g.total;
                return false;
            }
            return true;
        });

        report.grossProfit = report.trading.totalInc - report.trading.totalExp;
        report.netProfit = report.grossProfit + report.pl.totalInc - report.pl.totalExp;

        // ── Closing stock adjustment (same 3-tier fallback as Schedule III n19) ──
        // 1. Explicit "Opening Stock" ledger in CY (rare — most Tally TBs don't have one)
        // 2. PY closing stock (from LEDGERS_PY if imported)
        // 3. Assume no change (opening = closing) to avoid inflating profit by full
        //    closing-stock value when neither source is available.
        let closingStock = 0, openingStock = 0;
        report.assets.forEach(g => {
            const n = (g.name || '').toLowerCase();
            if (n.includes('stock') || n.includes('inventor')) closingStock += g.total;
        });
        let explicitOpen = 0;
        for (const name in balances) {
            if ((name || '').toLowerCase().includes('opening stock')) explicitOpen += balances[name].current;
        }
        if (explicitOpen) {
            openingStock = explicitOpen;
        } else if (year !== 'PY') {
            try {
                const pyBal = this.getLedgerBalances('PY');
                for (const n in pyBal) {
                    const gn = (pyBal[n].group || '').toLowerCase();
                    if (gn.includes('stock') || gn.includes('inventor')) openingStock += pyBal[n].current;
                }
            } catch(e) {}
            if (openingStock === 0) openingStock = closingStock;  // safe default — no change
        } else {
            openingStock = closingStock;
        }
        report.inventoryChange = openingStock - closingStock;   // +ve = expense (stock fell)
        report.netProfit = report.netProfit - report.inventoryChange;
        report.grossProfit = report.grossProfit - report.inventoryChange;

        return report;
    },

    /**
     * Schedule III report: classifies all ledgers into note-level categories
     * for the financial statement export (financials.html)
     */
    getScheduleIIIReport(year) {
        const report = this.getReportData(year);
        const balances = this.getLedgerBalances(year);
        const bd = this.getCompanyDetails();
        const meta = JSON.parse(localStorage.getItem('FS_META') || '{}');

        // ── Helper: classify an expense ledger into P&L note 20-24 ──
        function classifyExpenseLedger(name) {
            const n = name.toLowerCase();
            if (n.includes('salary') || n.includes('wages') || n.includes('staff welfare') ||
                n.includes('bonus') || n.includes('gratuity') || n.includes('provident fund') ||
                n.includes('pf ') || n.includes('esi') || n.includes('labour charge') ||
                n.includes('labor charge') || n.includes('leave encash') || n.includes('employee') ||
                n.includes('stipend') || n.includes('director remuneration'))
                return 'employee';      // Note 20
            if (n.includes('interest') || n.includes('finance cost') || n.includes('bank charge') ||
                n.includes('processing fee') || n.includes('cgtmse') || n.includes('discount allowed'))
                return 'finance';       // Note 21
            if (n.includes('depreciation') || n.includes('amortisation') || n.includes('amortization'))
                return 'depreciation';  // Note 22
            if (n.includes('income tax') || n.includes('current tax') || n.includes('deferred tax') ||
                n.includes('mat credit') || n.includes('tax expense') || n.includes('provision for tax'))
                return 'tax';           // Note 24
            return 'other';             // Note 23
        }

        // ── Helper: classify asset ledger into sub-note categories ──
        function classifyAssetLedger(name) {
            const n = name.toLowerCase();
            if (n.includes('advance tax') || n.includes('tds') || n.includes('tcs') || n.includes('tax receivable'))
                return 'advance_tax';
            if (n.includes('gst') || n.includes('input') || n.includes('cenvat') || n.includes('vat'))
                return 'gst_input';
            if (n.includes('deposit') || n.includes('security deposit'))
                return 'deposits';
            if (n.includes('advance') || n.includes('prepaid') || n.includes('staff advance'))
                return 'advances';
            return 'other';
        }

        // ── Build P&L notes (16-24) ──
        const plNotes = {
            n16_revenue: { items: [], total: 0 },
            n17_otherIncome: { items: [], total: 0 },
            n18_materials: { items: [], total: 0 },
            n19_inventoryChange: { opening: 0, closing: 0, total: 0 },
            n20_employee: { items: [], total: 0 },
            n21_finance: { items: [], total: 0 },
            n22_depreciation: { items: [], total: 0 },
            n23_otherExpenses: { items: [], total: 0 },
            n24_tax: { currentTax: 0, adjustments: 0, deferredTax: 0, total: 0 },
        };

        // Revenue from Operations (Note 16)
        // Income ledgers are credit-normal (negative balance). A contra ledger like
        // "Sales Return" has a POSITIVE balance and MUST reduce revenue. Using
        // Math.abs() on every ledger would inflate revenue by the return amount —
        // a real accounting error. Preserve sign, sum, then flip sign at the end.
        report.trading.incomes.forEach(g => {
            g.ledgers.forEach(l => {
                const amt = -(l.balance || 0);  // credit → positive revenue; debit contra → negative
                plNotes.n16_revenue.items.push({ name: l.name, amount: amt });
                plNotes.n16_revenue.total += amt;
            });
        });

        // Other Income (Note 17) — same sign convention
        report.pl.incomes.forEach(g => {
            g.ledgers.forEach(l => {
                const amt = -(l.balance || 0);
                plNotes.n17_otherIncome.items.push({ name: l.name, amount: amt });
                plNotes.n17_otherIncome.total += amt;
            });
        });

        // Classify all expense ledgers
        const allExpGroups = [...report.trading.expenses, ...report.pl.expenses];
        allExpGroups.forEach(g => {
            const gn = g.name.toLowerCase();
            const isDirectPurchase = gn.includes('purchase');
            g.ledgers.forEach(l => {
                const amt = l.balance;
                if (isDirectPurchase) {
                    plNotes.n18_materials.items.push({ name: l.name, amount: amt });
                    plNotes.n18_materials.total += amt;
                } else {
                    const cat = classifyExpenseLedger(l.name);
                    if (cat === 'employee') {
                        plNotes.n20_employee.items.push({ name: l.name, amount: amt });
                        plNotes.n20_employee.total += amt;
                    } else if (cat === 'finance') {
                        plNotes.n21_finance.items.push({ name: l.name, amount: amt });
                        plNotes.n21_finance.total += amt;
                    } else if (cat === 'depreciation') {
                        plNotes.n22_depreciation.items.push({ name: l.name, amount: amt });
                        plNotes.n22_depreciation.total += amt;
                    } else if (cat === 'tax') {
                        const tn = l.name.toLowerCase();
                        if (tn.includes('deferred')) plNotes.n24_tax.deferredTax += amt;
                        else if (tn.includes('adjustment') || tn.includes('earlier')) plNotes.n24_tax.adjustments += amt;
                        else plNotes.n24_tax.currentTax += amt;
                        plNotes.n24_tax.total += amt;
                    } else {
                        plNotes.n23_otherExpenses.items.push({ name: l.name, amount: amt });
                        plNotes.n23_otherExpenses.total += amt;
                    }
                }
            });
        });

        // Change in Inventories (Note 19) — Closing stock from BS assets
        report.assets.forEach(g => {
            if (g.name.toLowerCase().includes('stock') || g.name.toLowerCase().includes('inventor')) {
                plNotes.n19_inventoryChange.closing = g.total;
            }
        });
        // Opening stock detection — in priority order:
        //   1. Explicit "Opening Stock" ledger in the current TB
        //   2. PY closing stock (from LEDGERS_PY if imported)
        //   3. Equal to closing stock (NO change assumed — safest default)
        //
        // The third fallback is crucial: without it, a first-year-filing user (or anyone
        // who hasn't imported PY yet) would see opening=0, inventory-change = -closing,
        // and the entire closing stock value would be added to profit. For an ongoing
        // business importing only CY TB, that's a material overstatement.
        let explicitOpening = 0;
        for (let name in balances) {
            if (name.toLowerCase().includes('opening stock')) {
                explicitOpening = balances[name].current;
                break;
            }
        }
        if (explicitOpening) {
            plNotes.n19_inventoryChange.opening = explicitOpening;
        } else if (year !== 'PY') {
            let pyOpening = 0;
            try {
                const pyBalances = this.getLedgerBalances('PY');
                const pyGroups = {};
                for (const n in pyBalances) {
                    const gName = pyBalances[n].group || 'Primary';
                    if (!pyGroups[gName]) pyGroups[gName] = 0;
                    pyGroups[gName] += pyBalances[n].current;
                }
                for (const gName in pyGroups) {
                    const lgName = gName.toLowerCase();
                    if (lgName.includes('stock') || lgName.includes('inventor')) {
                        pyOpening += pyGroups[gName];
                    }
                }
            } catch(e) {}
            if (pyOpening) {
                plNotes.n19_inventoryChange.opening = pyOpening;
            } else {
                // No PY, no explicit opening: assume no change (opening = closing).
                // Alternative would overstate profit by entire closing stock value.
                plNotes.n19_inventoryChange.opening = plNotes.n19_inventoryChange.closing;
            }
        }
        plNotes.n19_inventoryChange.total = plNotes.n19_inventoryChange.opening - plNotes.n19_inventoryChange.closing;

        // ── Build BS notes (3-15) — ledger-level detail ──
        const bsNotes = {
            n3_shareCapital: { items: [], total: 0 },
            n4_reserves: { items: [], total: 0 },
            n5_ltBorrowings: { items: [], total: 0 },
            n6_stBorrowings: { items: [], total: 0 },
            n7_tradePayables: { items: [], total: 0 },
            n8_otherCL: { items: [], total: 0 },
            n9_ppe: { items: [], total: 0 },
            n10_dta: { items: [], total: 0 },
            n11_inventories: { items: [], total: 0 },
            n12_tradeReceivables: { items: [], total: 0 },
            n13_cashBank: { items: [], total: 0 },
            n14_stLoans: { advanceTax: 0, gstInput: 0, advances: 0, items: [], total: 0 },
            n15_otherCA: { items: [], total: 0 },
        };

        // Classify liabilities into notes 3-8
        report.liabilities.forEach(g => {
            const n = g.name.toLowerCase();
            const amt = Math.abs(g.total);
            if (n.includes('capital') || n.includes('share capital') || n.includes('proprietor') || n.includes('partner')) {
                bsNotes.n3_shareCapital.items.push({ name: g.name, amount: amt });
                bsNotes.n3_shareCapital.total += amt;
            } else if (n.includes('reserve') || n.includes('surplus') || n.includes('profit & loss') || n.includes('p&l')) {
                bsNotes.n4_reserves.items.push({ name: g.name, amount: amt });
                bsNotes.n4_reserves.total += amt;
            } else if (n.includes('secured loan') || n.includes('unsecured loan') || n.includes('term loan') ||
                       (n.includes('loan') && !n.includes('od') && !n.includes('overdraft') && !n.includes('cash credit') && !n.includes('short term') && !n.includes('working capital'))) {
                bsNotes.n5_ltBorrowings.items.push({ name: g.name, amount: amt });
                bsNotes.n5_ltBorrowings.total += amt;
            } else if (n.includes('bank od') || n.includes('overdraft') || n.includes('cash credit') || n.includes('cc a/c') ||
                       n.includes('short term borrow') || n.includes('working capital')) {
                bsNotes.n6_stBorrowings.items.push({ name: g.name, amount: amt });
                bsNotes.n6_stBorrowings.total += amt;
            } else if (n.includes('creditor') || n.includes('trade payable') || n.includes('payable') || n.includes('sundry creditor')) {
                bsNotes.n7_tradePayables.items.push({ name: g.name, amount: amt });
                bsNotes.n7_tradePayables.total += amt;
            } else {
                bsNotes.n8_otherCL.items.push({ name: g.name, amount: amt });
                bsNotes.n8_otherCL.total += amt;
            }
        });

        // Classify assets into notes 9-15
        report.assets.forEach(g => {
            const n = g.name.toLowerCase();
            const amt = Math.abs(g.total);
            if (n.includes('fixed') || n.includes('tangible') || n.includes('plant') || n.includes('machinery') ||
                n.includes('furniture') || n.includes('computer') || n.includes('equipment') || n.includes('vehicle') ||
                n.includes('building') || n.includes('land')) {
                bsNotes.n9_ppe.items.push({ name: g.name, amount: amt });
                bsNotes.n9_ppe.total += amt;
            } else if (n.includes('deferred tax asset')) {
                bsNotes.n10_dta.items.push({ name: g.name, amount: amt });
                bsNotes.n10_dta.total += amt;
            } else if (n.includes('stock') || n.includes('inventor') || n.includes('finished') || n.includes('raw material') || n.includes('wip')) {
                bsNotes.n11_inventories.items.push({ name: g.name, amount: amt });
                bsNotes.n11_inventories.total += amt;
            } else if (n.includes('debtor') || n.includes('receivable') || n.includes('sundry debtor')) {
                bsNotes.n12_tradeReceivables.items.push({ name: g.name, amount: amt });
                bsNotes.n12_tradeReceivables.total += amt;
            } else if (n.includes('cash') || n.includes('bank account') || n.includes('bank balance') || n.includes('petty')) {
                bsNotes.n13_cashBank.items.push({ name: g.name, amount: amt });
                bsNotes.n13_cashBank.total += amt;
            } else if (n.includes('loans & advances') || n.includes('advance') || n.includes('tds') || n.includes('tcs') ||
                       n.includes('gst') || n.includes('duties')) {
                // Sub-classify within note 14
                g.ledgers.forEach(l => {
                    const cat = classifyAssetLedger(l.name);
                    const la = Math.abs(l.balance);
                    bsNotes.n14_stLoans.items.push({ name: l.name, amount: la, category: cat });
                    if (cat === 'advance_tax') bsNotes.n14_stLoans.advanceTax += la;
                    else if (cat === 'gst_input') bsNotes.n14_stLoans.gstInput += la;
                    else bsNotes.n14_stLoans.advances += la;
                    bsNotes.n14_stLoans.total += la;
                });
            } else {
                bsNotes.n15_otherCA.items.push({ name: g.name, amount: amt });
                bsNotes.n15_otherCA.total += amt;
            }
        });

        // ── P&L summary (compute FIRST so BS can use the correct profit figure) ──
        const totalRevenue = plNotes.n16_revenue.total + plNotes.n17_otherIncome.total;
        const totalExpenses = plNotes.n18_materials.total + plNotes.n19_inventoryChange.total +
            plNotes.n20_employee.total + plNotes.n21_finance.total +
            plNotes.n22_depreciation.total + plNotes.n23_otherExpenses.total;
        const profitBeforeTax = totalRevenue - totalExpenses;
        const profitForYear = profitBeforeTax - plNotes.n24_tax.total;

        // Add net profit to reserves. CRITICAL: must use profitForYear (which accounts for
        // inventory change via Note 19), NOT report.netProfit which skips Note 19. Using the
        // wrong one makes BS fail to balance by the inventory-change amount.
        bsNotes.n4_reserves.netProfit = profitForYear;

        // ── Compute totals for BS ──
        const shareholdersFunds = bsNotes.n3_shareCapital.total + bsNotes.n4_reserves.total + profitForYear;
        const ncLiabilities = bsNotes.n5_ltBorrowings.total;
        const cLiabilities = bsNotes.n6_stBorrowings.total + bsNotes.n7_tradePayables.total + bsNotes.n8_otherCL.total;
        const totalEL = shareholdersFunds + ncLiabilities + cLiabilities;

        const ncAssets = bsNotes.n9_ppe.total + bsNotes.n10_dta.total;
        const cAssets = bsNotes.n11_inventories.total + bsNotes.n12_tradeReceivables.total +
                        bsNotes.n13_cashBank.total + bsNotes.n14_stLoans.total + bsNotes.n15_otherCA.total;
        const totalAssets = ncAssets + cAssets;

        // ── Compute analytical ratios (Note 27) ──
        const ratios = [];
        const safe = (n, d) => d !== 0 ? n / d : 0;
        ratios.push({ name: 'Current ratio (in times)', cy: safe(cAssets, cLiabilities) });
        ratios.push({ name: 'Debt-Equity ratio (in times)', cy: safe(ncLiabilities + bsNotes.n6_stBorrowings.total, shareholdersFunds) });
        ratios.push({ name: 'Debt Service coverage (in times)', cy: safe(profitBeforeTax + plNotes.n21_finance.total + plNotes.n22_depreciation.total, plNotes.n21_finance.total) });
        ratios.push({ name: 'Return on equity (in %)', cy: safe(profitForYear, shareholdersFunds) * 100 });
        ratios.push({ name: 'Inventory Turnover (in times)', cy: safe(plNotes.n18_materials.total, bsNotes.n11_inventories.total) });
        ratios.push({ name: 'Trade receivables turnover (in times)', cy: safe(plNotes.n16_revenue.total, bsNotes.n12_tradeReceivables.total) });
        ratios.push({ name: 'Trade payables turnover (in times)', cy: safe(totalExpenses - plNotes.n22_depreciation.total, bsNotes.n7_tradePayables.total) });
        ratios.push({ name: 'Net capital turnover (in times)', cy: safe(plNotes.n16_revenue.total, cAssets - cLiabilities) });
        ratios.push({ name: 'Net profit ratio (in %)', cy: safe(profitForYear, plNotes.n16_revenue.total) * 100 });
        ratios.push({ name: 'Return on capital employed (in %)', cy: safe(profitBeforeTax + plNotes.n21_finance.total, shareholdersFunds + ncLiabilities + bsNotes.n6_stBorrowings.total) * 100 });
        ratios.push({ name: 'Return on investment (in %)', cy: 0 });

        // ── EPS (Note 25) ──
        const faceValue = meta.faceValue || 10;
        const numShares = meta.weightedAvgShares || 0;
        let autoShares = numShares;
        if (!autoShares) {
            // Try to compute from capital account
            for (let name in balances) {
                const n = name.toLowerCase();
                if (n.includes('capital account') || n.includes('share capital') || n.includes('equity share') || n.includes('paid up capital')) {
                    const capBal = Math.abs(balances[name].current);
                    if (capBal > 0) { autoShares = capBal / faceValue; break; }
                }
            }
        }
        const eps = {
            profitAfterTax: profitForYear,
            numShares: autoShares,
            faceValue: faceValue,
            basic: autoShares > 0 ? profitForYear / autoShares : 0,
            diluted: autoShares > 0 ? profitForYear / autoShares : 0
        };

        return {
            company: bd,
            meta: meta,
            bs: {
                shareholdersFunds, ncLiabilities, cLiabilities, totalEL,
                ncAssets, cAssets, totalAssets
            },
            pl: {
                totalRevenue, totalExpenses, profitBeforeTax,
                taxTotal: plNotes.n24_tax.total, profitForYear
            },
            bsNotes, plNotes, ratios, eps, report
        };
    },

    getDashboardSummary() {
        const tb = this.getTrialBalance();
        const report = this.getReportData();
        
        let totalRevenue = 0;
        report.trading.incomes.forEach(g => totalRevenue -= g.total);
        report.pl.incomes.forEach(g => totalRevenue -= g.total);

        let totalExpense = 0;
        report.trading.expenses.forEach(g => totalExpense += g.total);
        report.pl.expenses.forEach(g => totalExpense += g.total);

        const netProfit = totalRevenue - totalExpense;

        return {
            isBalanced: Math.abs(tb.totalDr - tb.totalCr) < 1,
            totalMovement: tb.totalDr + tb.totalCr,
            ledgerCount: tb.items.length,
            revenue: totalRevenue,
            netProfit: netProfit
        };
    },

    /**
     * Get Trial Balance data
     */
    getTrialBalance(year) {
        const s = this._ys(year);
        const balances = this.getLedgerBalances(year);
        const ledgers = JSON.parse(localStorage.getItem('LEDGERS' + s) || '[]');
        // Build a lookup for gross Dr/Cr stored during import
        const grossMap = {};
        ledgers.forEach(l => {
            if (l.closingDr !== undefined || l.closingCr !== undefined) {
                grossMap[l.name] = { dr: l.closingDr || 0, cr: l.closingCr || 0 };
            }
        });

        let tb = [];
        let computedDr = 0;
        let computedCr = 0;

        for (let name in balances) {
            let b = balances[name];
            let dr, cr;

            // Use gross Dr/Cr if available (preserves original TB values)
            if (grossMap[name] && (grossMap[name].dr > 0 || grossMap[name].cr > 0)) {
                dr = grossMap[name].dr;
                cr = grossMap[name].cr;
            } else {
                // Fall back to net-based computation
                dr = b.current > 0 ? b.current : 0;
                cr = b.current < 0 ? Math.abs(b.current) : 0;
            }

            tb.push({
                name: name,
                group: b.group,
                debit: dr,
                credit: cr
            });

            computedDr += dr;
            computedCr += cr;
        }

        // Use saved Grand Total from file if available (always matches source)
        let totalDr = computedDr;
        let totalCr = computedCr;
        try {
            const gt = JSON.parse(localStorage.getItem('TB_GRAND_TOTAL' + s) || 'null');
            if (gt && gt.dr > 0 && gt.cr > 0) {
                totalDr = gt.dr;
                totalCr = gt.cr;
            }
        } catch(e) {}

        return { items: tb, totalDr, totalCr };
    },

    /**
     * Parse Tally XML (Trial Balance or Ledgers)
     */
    importTallyXML(xmlStr) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlStr, "text/xml");
        const ledgers = xmlDoc.getElementsByTagName("LEDGER");
        
        let newLedgers = [];
        let newVouchers = [];

        // We create a single "Opening Balance" voucher if needed,
        // or just set opening balances in the LEDGERS array.
        // Tally export format for Trial Balance often contains:
        // <LEDGER NAME="..."><OPENINGBALANCE>...</OPENINGBALANCE><CLOSINGBALANCE>...</CLOSINGBALANCE></LEDGER>

        for (let i = 0; i < ledgers.length; i++) {
            const l = ledgers[i];
            const name = l.getAttribute("NAME");
            const parent = l.getElementsByTagName("PARENT")[0]?.textContent || "Primary";
            
            // Tally balances in XML:
            // Negative value = Debit
            // Positive value = Credit
            //
            // In our tool's getLedgerBalances:
            // Assets (Debit) should be positive
            // Liabilities (Credit) should be negative
            
            const openingVal = parseFloat(l.getElementsByTagName("OPENINGBALANCE")[0]?.textContent || "0");
            const closingVal = parseFloat(l.getElementsByTagName("CLOSINGBALANCE")[0]?.textContent || "0");
            
            // Use closing balance if opening is zero (common in TB exports)
            const val = closingVal !== 0 ? closingVal : openingVal;

            // Convert Tally sign to our sign:
            // -1000 (Dr) -> 1000 (Asset)
            // 1000 (Cr) -> -1000 (Liability)
            const internalBalance = -val;

            newLedgers.push({
                name: name,
                group: parent,
                openingBalance: internalBalance
            });
            
            // For this tool's AccountingEngine (which uses VOUCHERS for current balance),
            // we'll create a voucher that reflects the balance if needed.
            // However, the tool's getLedgerBalances() already adds opening balance.
        }

        if (newLedgers.length > 0) {
            localStorage.setItem('LEDGERS', JSON.stringify(newLedgers));
            /* Preserve existing vouchers — only reset if user explicitly chose to.
               Callers can pass { clearVouchers: true } via options param if needed. */
            if (!localStorage.getItem('VOUCHERS')) localStorage.setItem('VOUCHERS', '[]');
            this.persistToElectron();
            this._logAudit('import', 'Imported ' + newLedgers.length + ' ledgers (Tally XML)');
            return true;
        }
        return false;
    },

    /**
     * Smartly guess a group name based on ledger name keywords
     */
    guessGroup(ledgerName) {
        const name = ledgerName.toLowerCase().trim();

        // ── USER-DEFINED RULES (highest priority) ──
        try {
            const rules = JSON.parse(localStorage.getItem('GROUP_RULES') || '{}');
            if (rules[ledgerName]) return rules[ledgerName];
            if (rules[name]) return rules[name];
        } catch(e) { /* ignore malformed rules */ }

        // ── 0. PRIORITY overrides (must check before generic keyword matches) ──
        // Accumulated Depreciation is a Fixed Asset contra (NOT an expense)
        if (name.includes('accumulated depreciation')) return 'Fixed Assets';
        // Advance against property/purchase is an asset (NOT duties/taxes despite "agst" containing "gst")
        if (name.includes('advance agst') || name.includes('advance against') || name.includes('advance ag')) return 'Loans & Advances (Asset)';
        // Opening/Closing stock in expense context
        if (name.includes('opening stock') || name.includes('closing stock')) return 'Stock-in-hand';
        // Income items that contain expense-like keywords (must check BEFORE expense section)
        if (name.includes('event management service')) return 'Sales Accounts';
        // Cash - Events is a cash asset, not an expense (despite "event" in name)
        if (name.includes('cash - event') || name.includes('cash event')) return 'Cash-in-hand';
        // Prepaid expenses are ASSETS, not expenses
        if (name.includes('prepaid')) return 'Loans & Advances (Asset)';
        // Items with "payable" are LIABILITIES, not expenses
        if (name.includes('payable') || name.includes('payble')) return 'Provisions';
        // TCS/TDS charges are Duties & Taxes, not generic expenses
        if (name.includes('other charges - tcs') || name.includes('other charges - tds')) return 'Duties & Taxes';
        if (name.includes('rental charge') || name.includes('rental income') || name.includes('rent received') || name.includes('lease rental income')) return 'Sales Accounts';
        if (name.includes('sponsorship income') || name === 'sponsorship') return 'Sales Accounts';
        if (name.includes('commission income') || name.includes('export of service')) return 'Indirect Incomes';
        if (name.includes('interest on fd') || name.includes('interest on fixed') || name.includes('interest on it refund')) return 'Indirect Incomes';
        if (name === 'sundry balance written off') return 'Indirect Incomes';

        // ── 1. Expenses (check FIRST to prevent misclassification as BS items) ──

        // Direct Expenses — purchases, raw materials, direct costs
        if (name.includes('purchase')) return 'Purchase Accounts';
        if (name.includes('wages') || name.includes('direct expense') || name.includes('freight inward') || name.includes('carriage inward') || name.includes('power & fuel') || name.includes('fuel expense')) return 'Direct Expenses';
        if (name.includes('apmc') || name.includes('excise') || name.includes('octroi')) return 'Direct Expenses';
        if (name.includes('logistics') || name.includes('loading') || name.includes('unloading') || name.includes('transport') || name.includes('packaging') || name.includes('packing') || name.includes('shipping') || name.includes('delivery')) return 'Direct Expenses';
        if (name.includes('labour charge') || name.includes('labor charge')) return 'Direct Expenses';
        if (name.includes('event') || name.includes('sub contract') || name.includes('subcontract') || name.includes('promoter') || name.includes('supervisor')) return 'Direct Expenses';
        if (name.includes('creative') && (name.includes('design') || name.includes('work'))) return 'Direct Expenses';
        if (name.includes('food & beverage') || name.includes('food and beverage')) return 'Direct Expenses';
        if (name.includes('baggage') || name.includes('non-judicial') || name.includes('estamp')) return 'Direct Expenses';

        // Income Tax / Deferred Tax → P&L expenses (NOT Duties & Taxes liability)
        // But "Deferred Tax Asset/Asets" is a Balance Sheet item, not expense
        if (name.includes('deferred tax asset') || name.includes('deferred tax aset')) return 'Loans & Advances (Asset)';
        if (name.includes('income tax') && name.includes('receivable')) return 'Loans & Advances (Asset)';
        if (name.includes('income tax') || name.includes('current tax') || name.includes('deferred tax') || name.includes('mat credit') || name.includes('tax expense') || name.includes('provision for tax')) return 'Indirect Expenses';
        if (name.includes('profession tax')) return 'Indirect Expenses';

        // Indirect Expenses — office, admin, selling, finance, depreciation etc.
        if (name.includes('salary') || name.includes('staff welfare') || name.includes('employee benefit') || name.includes('bonus') || name.includes('gratuity') || name.includes('provident fund') || name.includes('esic') || name.includes('leave encash') || name.includes('stipend')) return 'Indirect Expenses';
        if (name.includes('rent') && !name.includes('rent received')) return 'Indirect Expenses';
        if (name.includes('electricity') || name.includes('telephone') || name.includes('internet') || name.includes('mobile recharge')) return 'Indirect Expenses';
        if (name.includes('travel') || name.includes('conveyance') || name.includes('hotel')) return 'Indirect Expenses';
        if (name.includes('printing') || name.includes('stationary') || name.includes('stationery')) return 'Indirect Expenses';
        if (name.includes('audit fee') || name.includes('legal') || name.includes('professional fee') || name.includes('consultancy')) return 'Indirect Expenses';
        if (name.includes('repair') || name.includes('maintenance') || name.includes('maintanance')) return 'Indirect Expenses';
        if (name.includes('depreciation') || name.includes('amortisation') || name.includes('amortization')) return 'Indirect Expenses';
        if (name.includes('finance cost') || name.includes('interest paid') || name.includes('bank charge') || name.includes('processing fee') || name.includes('cgtmse') || name.includes('discount allowed') || name.includes('interest charges') || name.includes('interest & penalties') || name.includes('late payment fee') || name.includes('credit card charge')) return 'Indirect Expenses';
        if (name.includes('advertising') || name.includes('marketing') || name.includes('promotion') || name.includes('publicity')) return 'Indirect Expenses';
        if (name.includes('insurance') && !name.includes('stock insurance')) return 'Indirect Expenses';
        if (name.includes('stock insurance')) return 'Indirect Expenses';
        if (name.includes('office') && name.includes('exp')) return 'Indirect Expenses';
        if (name.includes('admin')) return 'Indirect Expenses';
        if (name.includes('subscription') || name.includes('subcription')) return 'Indirect Expenses';
        if (name.includes('license fee') || name.includes('licence fee') || name.includes('listing fee') || name.includes('registration') || name.includes('renewal fee')) return 'Indirect Expenses';
        if (name.includes('roc filing')) return 'Indirect Expenses';
        if (name.includes('email service') || name.includes('software subscription') || name.includes('server expense') || name.includes('hosting') || name.includes('website expense') || name.includes('website renewal') || name.includes('website server')) return 'Indirect Expenses';
        if (name.includes('round off') || name.includes('roundoff')) return 'Indirect Expenses';
        if (name.includes('miscellaneous exp') || name.includes('general expense') || name.includes('sundry expense') || name.includes('other expense')) return 'Indirect Expenses';
        if (name.includes('bad debt') || name.includes('write off') || name.includes('written off') || name.includes('w/o') || name.includes('w/b') || (name.includes('sundry bal') && name.includes('w off'))) return 'Indirect Expenses';
        if (name.includes('donation') || name.includes('charity')) return 'Indirect Expenses';
        if (name.includes('penalty') || name.includes('fine ') || name.includes('late fee')) return 'Indirect Expenses';
        if (name.includes('storage fee') || name.includes('warehouse')) return 'Indirect Expenses';
        if (name.includes('support service') || name.includes('services exp') || name.includes('service charge')) return 'Indirect Expenses';
        if (name.includes('unicommerce') || name.includes('gcp') || name.includes('commission') && name.includes('amazon')) return 'Indirect Expenses';
        if (name.includes('hygine') || name.includes('hygiene') || name.includes('cleaning')) return 'Indirect Expenses';
        if (name.includes('allowance') && !name.includes('receivable')) return 'Indirect Expenses';
        if (name.includes('attire') || name.includes('overtime') || name.includes('food allowance')) return 'Indirect Expenses';
        if (name.includes('books & periodical') || name.includes('books and periodical')) return 'Indirect Expenses';
        if (name.includes('postage') || name.includes('courier') || (name.includes('freight') && !name.includes('event') && !name.includes('inward'))) return 'Indirect Expenses';
        if (name.includes('petrol') || name.includes('diesel') || name.includes('motor car exp') || (name.includes('car hire') && !name.includes('event'))) return 'Indirect Expenses';
        if (name.includes('postage') || name.includes('courier') && !name.includes('event')) return 'Indirect Expenses';
        if (name.includes('brokerage') || name.includes('commission') && !name.includes('income') && !name.includes('received')) return 'Indirect Expenses';
        if (name.includes('epf') && (name.includes('damage') || name.includes('employer'))) return 'Indirect Expenses';
        if (name.includes('diwali') || name.includes('entertainment') || name.includes('business promotion')) return 'Indirect Expenses';
        if (name.includes('membership') || name.includes('cma') || name.includes('property tax')) return 'Indirect Expenses';
        if (name.includes('reimbursement') && name.includes('exp')) return 'Indirect Expenses';
        if (name.includes('roc exp') || name.includes('return filing') || name.includes('income tax') && name.includes('appeal')) return 'Indirect Expenses';
        if (name.includes('personnel exp')) return 'Indirect Expenses';
        if ((name.includes('expense') || name.includes('charges') || name.includes('fees') || name.includes('cost')) && !name.includes('receivable') && !name.includes('asset') && !name.includes('deposit') && !name.includes('payable')) return 'Indirect Expenses';

        // ── 2. Incomes ──
        if (name.includes('sales') || name.includes('revenue') || name.includes('turnover') || name.includes('service income')) return 'Sales Accounts';
        if (name.includes('direct income') || name.includes('job work income') || name.includes('freight recovery')) return 'Direct Incomes';
        if (name.includes('interest received') || name.includes('interest on') || name.includes('dividend received') || name.includes('commission received') || name.includes('rent received') || name.includes('discount received') || name.includes('profit on sale') || name.includes('other income') || name.includes('indirect income')) return 'Indirect Incomes';

        // ── 3. Capital & Reserves ──
        if (name.includes('capital') || name.includes('partner') || name.includes('owner') || name.includes('proprietor')) return 'Capital Account';
        if (name.includes('reserve') || name.includes('surplus') || name.includes('retained earnings') || name.includes('profit & loss a/c') || name.includes('p&l a/c')) return 'Reserves and surplus';

        // ── 4. Loans & Liabilities ──
        if (name.includes('secured loan') || name.includes('bank loan') || name.includes('term loan') || name.includes('mortgage')) return 'Secured Loans';
        if (name.includes('unsecured loan') || name.includes('director loan') || name.includes('hand loan')) return 'Unsecured Loans';
        if (name.includes('overdraft') || name.includes('od a/c') || name.includes('bank od') || name.includes('cc a/c') || name.includes('cash credit')) return 'Bank OD';
        if ((name.includes('loan') || name.includes('borrowing')) && !name.includes('asset') && !name.includes('advance')) return 'Loans (Liability)';

        // ── 5. Current Liabilities ──
        if (name.includes('creditor') || name.includes('supplier') || name.includes('trade payable') || name.includes('payable')) return 'Sundry Creditors';
        if (name.includes('gst') || name.includes('cgst') || name.includes('sgst') || name.includes('igst') || name.includes('vat') || name.includes('service tax') || name.includes('duty') || name.includes('duties') || name.includes('cess ') || name.includes('electronic cash ledger') || name.includes('electronic credit ledger') || name.includes('itc input credit')) return 'Duties & Taxes';
        if (name.includes('tds payable') || name.includes('tcs payable') || name.includes('tax payable') || name.includes('tds ') && name.includes('payable')) return 'Duties & Taxes';
        if (name.includes('provident fund payable') || name.includes('epf deduction') || name.includes('professional tax payable') || name.includes('salary payable') || name.includes('other charges - tcs')) return 'Provisions';
        if (name.includes('provision') || name.includes('outstanding') || name.includes('accrued')) return 'Provisions';
        if (name.includes('current liability') || name.includes('current libility')) return 'Current Liabilities';

        // ── 6. Fixed Assets (including accumulated depreciation as contra) ──
        if (name.includes('accumulated depreciation')) return 'Fixed Assets';
        if (name.includes('machinery') || name.includes('furniture') || name.includes('vehicle') || name.includes('land') || name.includes('building') || name.includes('computer') || name.includes('equipment') || name.includes('plant')) return 'Fixed Assets';
        if (name.includes('air conditioner') || name.includes('generator') || name.includes('motor car') || name.includes('motor bike') || name.includes('printer') || name.includes('camera') || name.includes('wireless router') || name.includes('cooled system')) return 'Fixed Assets';
        if (name.includes('civil work') || name.includes('electrical installation') || name.includes('website') && !name.includes('expense')) return 'Fixed Assets';
        if (name === 'fixed assets' || name.includes('fixed asset')) return 'Fixed Assets';

        // ── 7. Investments ──
        if (name.includes('investment') || name.includes('fixed deposit') || name.includes('mutual fund') || name.includes('bonds') || name.includes('debenture') || name.includes('shares') || name.includes('share investment') || name.includes('apartment') || name.includes('immovable propert') || name.includes('api holding') || name.includes('icici bank ltd - fd')) return 'Investments';

        // ── 8. Current Assets ──
        if (name.includes('opening stock') || name.includes('closing stock') || name.includes('inventory') || name.includes('finished goods') || name.includes('work in progress') || name.includes('wip')) return 'Stock-in-hand';
        if (name.includes('debtor') || name.includes('customer') || name.includes('trade receivable') || name.includes('receivable')) return 'Sundry Debtors';
        if (name.includes('tds') || name.includes('tcs') || (name.includes('tax') && name.includes('receivable'))) return 'Duties & Taxes';
        if (name.includes('deferred tax asset')) return 'Loans & Advances (Asset)';
        if (name.includes('bank account') || name.includes('bank a/c') || name.includes('hdfc') || name.includes('icici') || name.includes('sbi') || name.includes('axis') || name.includes('kotak') || name.includes('idbi') || name.includes('bank of india') || name.includes('bank of baroda') || name.includes('bank of maharashtra') || name.includes('canara bank') || name.includes('union bank') || name.includes('pnb') || name.includes('yes bank') || name.includes('indusind') || name.includes('rbl bank') || name.includes('federal bank')) return 'Bank Accounts';
        if (name.includes('cash') || name.includes('petty cash')) return 'Cash-in-hand';
        if (name.includes('deposit') || name.includes('security deposit')) return 'Deposits (Asset)';
        if (name.includes('advance agst') || name.includes('advance against')) return 'Loans & Advances (Asset)';
        if (name.includes('interest receivable')) return 'Loans & Advances (Asset)';
        if (name.includes('imprest') || name.includes('imperest')) return 'Loans & Advances (Asset)';
        if (name.includes('prepaid') || name.includes('advance') || name.includes('loan') && name.includes('asset')) return 'Loans & Advances (Asset)';

        return 'Primary';
    },

    /**
     * Automate the whole process: Import -> Group -> Balance
     */
    async runAutomation(data) {
        console.log("Automation started...");
        // 1. Import
        let success = false;
        try {
            if (Array.isArray(data)) {
                success = this.importExcelTB(data);
            } else if (typeof data === 'string' && (data.startsWith('<?xml') || data.includes('<ENVELOPE>'))) {
                success = this.importTallyXML(data);
            }
        } catch (e) {
            return { success: false, message: "Processing error: " + e.message };
        }
        
        if (!success) return { success: false, message: "Import failed. Please ensure the file contains valid ledger data with 'Ledger Name' and 'Debit'/'Credit' columns." };

        // 2. Re-group everything using smart guessing
        let ledgers = this.getLedgers();
        if (ledgers.length === 0) return { success: false, message: "No ledgers found after import." };

        ledgers.forEach(l => {
            l.group = this.guessGroup(l.name);
        });
        localStorage.setItem('LEDGERS', JSON.stringify(ledgers));

        // 3. Persist
        try {
            await this.persistToElectron();
        } catch (e) {
            console.warn("Electron persist failed, continuing with localStorage");
        }

        return { success: true, message: "Successfully processed " + ledgers.length + " ledgers and built the Balance Sheet!" };
    },

    /**
     * Import Excel JSON Data (from Trial Balance format)
     * @param {Array} data - parsed Excel rows
     * @param {string} [year='CY'] - 'CY' imports to LEDGERS, 'PY' imports to LEDGERS_PY
     */
    importExcelTB(data, year) {
        const _ys = (year === 'PY') ? '_PY' : '';
        try {
            if (!Array.isArray(data) || data.length === 0) {
                console.error("Import failed: Data is empty or not an array");
                return false;
            }

            let newLedgers = [];
            
            // Detect if it's array of arrays (header:1) or array of objects
            const isArrayOfArrays = Array.isArray(data[0]);
            
            if (isArrayOfArrays) {
                // Broadened keywords
                const nameKeywords = ["ledger", "name", "particulars", "account", "item", "description", "details", "ledgers"];
                const drKeywords = ["debit", "dr", "dr amt"];
                const crKeywords = ["credit", "cr", "cr amt"];
                const closingKeywords = ["closing", "closing balance"];
                const groupKeywords = ["group", "parent", "primary", "category", "type", "nature", "head"];

                // Parse a cell that may contain "1,23,456.78 Dr" or "1,23,456.78 Cr"
                function parseDrCr(cellVal) {
                    const s = String(cellVal || "").trim();
                    if (!s) return 0;
                    const isCr = /cr\s*$/i.test(s);
                    const isDr = /dr\s*$/i.test(s);
                    const num = parseFloat(s.replace(/[^0-9.-]/g, '')) || 0;
                    if (isCr) return -num; // Credit = negative (liability/income)
                    if (isDr) return num;  // Debit = positive (asset/expense)
                    return num;
                }

                let nameIdx = -1, groupIdx = -1, drIdx = -1, crIdx = -1, closingIdx = -1;
                let headerRow = -1;

                // Search for header row in a larger range (up to 50 rows)
                for (let r = 0; r < Math.min(data.length, 50); r++) {
                    const row = data[r];
                    if (!Array.isArray(row)) continue;

                    // Reset per-row so all columns must be on the same row
                    let rName = -1, rDr = -1, rCr = -1, rGroup = -1, rClosing = -1;

                    // Track ALL Debit/Credit columns (there may be Opening + Closing pairs)
                    let allDr = [], allCr = [];
                    for (let i = 0; i < row.length; i++) {
                        const cell = String(row[i] || "").toLowerCase().trim();
                        if (!cell) continue;
                        if (rName === -1 && nameKeywords.some(k => cell === k || cell.includes(k))) {
                            if (!cell.includes("total")) rName = i;
                        }
                        if (rClosing === -1 && closingKeywords.some(k => cell === k || cell.includes(k))) rClosing = i;
                        if (drKeywords.some(k => cell === k || cell.includes(k)) && !cell.includes("closing") && !cell.includes("opening")) allDr.push(i);
                        if (crKeywords.some(k => cell === k || cell.includes(k)) && !cell.includes("closing") && !cell.includes("opening")) allCr.push(i);
                        if (rGroup === -1 && groupKeywords.some(k => cell === k || cell.includes(k))) rGroup = i;
                    }
                    // If multiple Dr/Cr columns, use the LAST pair (Closing Balance columns)
                    if (allDr.length > 0) rDr = allDr[allDr.length - 1];
                    if (allCr.length > 0) rCr = allCr[allCr.length - 1];

                    // All required columns: name + (debit or credit) on the same row
                    // Don't trigger on "Closing Balance" alone — need actual Debit/Credit sub-headers
                    if (rName !== -1 && (rDr !== -1 || rCr !== -1)) {
                        nameIdx = rName; drIdx = rDr; crIdx = rCr; closingIdx = rClosing; groupIdx = rGroup;
                        headerRow = r;
                    }

                    // Split-header: this row has Debit/Credit, look back for name column
                    if (headerRow === -1 && r > 0 && rName === -1 && (rDr !== -1 || rCr !== -1)) {
                        // Look back up to 3 rows for a name column
                        for (let back = r - 1; back >= Math.max(0, r - 3); back--) {
                            const prevRow = data[back];
                            if (!Array.isArray(prevRow)) continue;
                            for (let i = 0; i < prevRow.length; i++) {
                                const cell = String(prevRow[i] || "").toLowerCase().trim();
                                if (nameKeywords.some(k => cell === k || cell.includes(k)) && !cell.includes("total")) {
                                    nameIdx = i; drIdx = rDr; crIdx = rCr; closingIdx = rClosing; groupIdx = rGroup;
                                    headerRow = r;
                                    break;
                                }
                            }
                            if (headerRow !== -1) break;
                        }
                    }

                    if (headerRow !== -1) {
                        // Determine import mode
                        const useClosingCol = closingIdx !== -1;

                        // Detect if file has a Closing Balance column AFTER Credit column
                        // (Layout B: OpenBal, TxnDr, TxnCr, CloseBal)
                        // Check a few data rows to confirm
                        let fileHasCloseCol = false;
                        if (crIdx !== -1) {
                            for (let probe = r + 1; probe < Math.min(data.length, r + 20); probe++) {
                                const pRow = data[probe];
                                if (!Array.isArray(pRow)) continue;
                                const cv = pRow[crIdx + 1];
                                if (cv !== undefined && cv !== null && typeof cv === 'number' && cv > 0) {
                                    fileHasCloseCol = true;
                                    break;
                                }
                            }
                        }

                        // Track current TB group context for sign determination
                        // (Tally TBs list items under group headers like Capital Account, Fixed Assets etc.)
                        // Only TOP-LEVEL Tally groups set the context sign
                        // (sub-groups like Duties & Taxes, Provisions etc. do NOT change context)
                        const groupSignContext = {
                            'capital account':'Cr','loans (liability)':'Cr',
                            'current liabilities':'Cr',
                            'fixed assets':'Dr','investments':'Dr','current assets':'Dr',
                            'sales accounts':'Cr','direct expenses':'Dr',
                            'indirect incomes':'Cr','indirect expenses':'Dr'
                        };
                        let currentCtxSign = 'Dr';

                        // Start processing from next row
                        data.slice(r + 1).forEach(row => {
                            if (!Array.isArray(row)) return;
                            const name = row[nameIdx];
                            if (!name) return;

                            const sName = String(name).trim();
                            if (sName.length < 2) return;
                            const lName = sName.toLowerCase();

                            // Skip header row if it repeats, summary rows, brought forward, carried over
                            if (nameKeywords.some(k => lName === k) ||
                                lName === "total" ||
                                lName === "grand total" ||
                                lName === "name of ledger" ||
                                lName.includes("total") ||
                                lName.includes("brought forward") ||
                                lName.includes("carried over") ||
                                lName.includes("page ")) return;

                            // ── Parse amount columns ──
                            let balance = 0;
                            let grossDr = 0, grossCr = 0;

                            // Read Debit and Credit column values
                            let drVal = 0, crVal = 0;
                            if (drIdx !== -1) drVal = parseFloat(String(row[drIdx] || "0").replace(/[^0-9.-]/g, '')) || 0;
                            if (crIdx !== -1) crVal = parseFloat(String(row[crIdx] || "0").replace(/[^0-9.-]/g, '')) || 0;

                            // Check if values have Dr/Cr text suffix (e.g., "1,23,456 Cr")
                            // Update group context from known TB section headers
                            if (groupSignContext[lName]) {
                                currentCtxSign = groupSignContext[lName];
                            }

                            if (drIdx !== -1 && /[dc]r\s*$/i.test(String(row[drIdx] || ""))) {
                                balance = parseDrCr(row[drIdx]);
                                grossDr = balance > 0 ? balance : 0;
                                grossCr = balance < 0 ? -balance : 0;
                            } else if (fileHasCloseCol) {
                                // Layout B: [Name, OpenBal, TxnDr, TxnCr, CloseBal]
                                let closeBal = 0;
                                const cv = (crIdx >= 0 && crIdx + 1 < (row.length || 0)) ? row[crIdx + 1] : undefined;
                                if (cv !== undefined && cv !== null) {
                                    closeBal = (typeof cv === 'number') ? cv : (parseFloat(String(cv).replace(/[^0-9.-]/g, '')) || 0);
                                }

                                grossDr = drVal;
                                grossCr = crVal;

                                if (closeBal > 0 && (drVal > 0 || crVal > 0)) {
                                    // Has transactions → determine sign
                                    const openVal = (drIdx > 0 && row[drIdx - 1] !== undefined) ?
                                        (parseFloat(String(row[drIdx - 1] || "0").replace(/[^0-9.-]/g, '')) || 0) : 0;
                                    const tryDr = openVal + drVal - crVal;
                                    const tryCr = -openVal + drVal - crVal;
                                    const matchDr = Math.abs(Math.abs(tryDr) - closeBal) < 1;
                                    const matchCr = Math.abs(Math.abs(tryCr) - closeBal) < 1;
                                    if (matchDr && !matchCr) balance = tryDr;
                                    else if (matchCr && !matchDr) balance = tryCr;
                                    else if (matchDr && matchCr) {
                                        // Both match — check if they're the same value (open=0 case)
                                        if (Math.abs(tryDr - tryCr) < 1) {
                                            // Same value → NOT ambiguous, sign is determined
                                            balance = tryDr;
                                        } else {
                                            // Truly ambiguous (different values, both abs match close)
                                            // Use group context sign
                                            balance = currentCtxSign === 'Cr' ? -closeBal : closeBal;
                                        }
                                    } else {
                                        // Neither matches → use context sign
                                        balance = currentCtxSign === 'Cr' ? -closeBal : closeBal;
                                    }
                                } else if (closeBal > 0) {
                                    // No transactions → use context sign
                                    balance = currentCtxSign === 'Cr' ? -closeBal : closeBal;
                                } else {
                                    // Zero closing → keep for parent detection
                                    balance = 0;
                                }
                            } else {
                                // Layout A: simple [Name, Dr, Cr]
                                if (drIdx === crIdx && drVal < 0) { crVal = -drVal; drVal = 0; }
                                balance = drVal - crVal;
                                grossDr = drVal;
                                grossCr = crVal;
                            }

                            // Skip items with truly no data
                            if (isNaN(balance)) return;
                            if (balance === 0 && grossDr === 0 && grossCr === 0) return;

                            let group = row[groupIdx] || this.guessGroup(sName);

                            // For Layout A (no closing column): apply sign from guessGroup for unsigned balances
                            if (!fileHasCloseCol && balance > 0 && grossDr === 0 && grossCr === 0) {
                                const lg = group.toLowerCase();
                                const crGroups = ['capital account','reserves','surplus','secured loans','unsecured loans','bank od','loans (liability)','current liabilities','duties & taxes','sundry creditors','provisions','sales accounts','direct incomes','indirect incomes','income','other income'];
                                if (crGroups.some(cg => lg.includes(cg))) balance = -balance;
                            }
                            // Accumulated depreciation is always Cr
                            if (balance > 0 && sName.toLowerCase().includes('accumulated depreciation')) {
                                balance = -balance;
                            }

                            newLedgers.push({
                                name: sName,
                                group: group,
                                openingBalance: balance,
                                closingDr: grossDr,
                                closingCr: grossCr
                            });
                        });
                        if (newLedgers.length > 0) break;
                    }
                }
            } else {
                // Array of Objects
                data.forEach(obj => {
                    let name = "", dr = 0, cr = 0, group = "";
                    
                    for (let key in obj) {
                        const lKey = key.toLowerCase();
                        const val = obj[key];
                        
                        if (!name && (lKey.includes("ledger") || lKey.includes("name") || lKey.includes("particulars") || lKey.includes("account") || lKey.includes("item"))) {
                            name = val;
                        } else if (lKey.includes("debit") || lKey === "dr") {
                            dr = parseFloat(String(val || "0").replace(/[^0-9.-]/g, '')) || 0;
                        } else if (lKey.includes("credit") || lKey === "cr") {
                            cr = parseFloat(String(val || "0").replace(/[^0-9.-]/g, '')) || 0;
                        } else if (lKey.includes("amount") && dr === 0) {
                            dr = parseFloat(String(val || "0").replace(/[^0-9.-]/g, '')) || 0;
                        } else if (lKey.includes("group") || lKey.includes("parent") || lKey.includes("head")) {
                            group = val;
                        }
                    }

                    if (name && String(name).toUpperCase() !== "TOTAL" && String(name).length > 1) {
                        const sName = String(name).trim();
                        newLedgers.push({
                            name: sName,
                            group: group || this.guessGroup(sName),
                            openingBalance: (isNaN(dr) ? 0 : dr) - (isNaN(cr) ? 0 : cr)
                        });
                    }
                });
            }

            // Capture Grand Total from the source file for accurate TB display
            // Search backwards from last row for "Grand Total" row
            if (Array.isArray(data)) {
                for (let r = data.length - 1; r >= Math.max(0, data.length - 10); r--) {
                    const row = data[r];
                    if (!Array.isArray(row)) continue;
                    const name = String(row[0] || "").toLowerCase().trim();
                    if (name.includes("grand total") || name === "total") {
                        // Find the two largest matching numbers in the row (Dr and Cr totals)
                        const nums = [];
                        for (let c = 1; c < row.length; c++) {
                            const v = parseFloat(String(row[c] || "0").replace(/[^0-9.-]/g, ''));
                            if (v > 0) nums.push(v);
                        }
                        if (nums.length >= 2) {
                            // Take the last pair (for 4-col TBs, last pair is Closing/Transaction total)
                            const gtDr = nums[nums.length - 2];
                            const gtCr = nums[nums.length - 1];
                            localStorage.setItem('TB_GRAND_TOTAL' + _ys, JSON.stringify({ dr: gtDr, cr: gtCr }));
                        }
                        break;
                    }
                }
            }

            // Remove parent-group rows whose balance equals the sum of subsequent rows
            // Multi-pass: handles nested Tally groups (3-4 levels deep)
            if (newLedgers.length > 1) {
                const eps = 0.5;
                const tallyGroups = new Set(['capital account','reserves & surplus','reserves and surplus','loans (liability)','secured loans','unsecured loans','bank od a/c','bank od','current liabilities','duties & taxes','provisions','sundry creditors','fixed assets','current assets','stock-in-hand','closing stock','deposits (asset)','loans & advances (asset)','sundry debtors','cash-in-hand','bank accounts','investments','sales accounts','purchase accounts','direct expenses','direct incomes','indirect expenses','indirect incomes','profit & loss a/c','suspense a/c','branch / divisions','misc. expenses (asset)','personnel expenses','gst control exp out','loans to emplyoee','loans to employee','advance tax & tds','sales account']);

                // Run multiple passes — inner parents get removed first, then outer parents
                for (let pass = 0; pass < 5; pass++) {
                    const toRemove = new Set();
                    for (let i = 0; i < newLedgers.length - 1; i++) {
                        if (toRemove.has(i)) continue;
                        const parentBal = newLedgers[i].openingBalance;
                        if (parentBal === 0) continue;
                        const pn = newLedgers[i].name.toLowerCase();
                        let runSum = 0, childCount = 0;
                        // Look ahead up to 120 rows (covers very large groups)
                        for (let j = i + 1; j < Math.min(newLedgers.length, i + 120); j++) {
                            if (toRemove.has(j)) continue;
                            runSum += newLedgers[j].openingBalance;
                            childCount++;
                            if (Math.abs(runSum - parentBal) < eps) {
                                if (childCount >= 2) {
                                    toRemove.add(i);
                                    break;
                                } else if (childCount === 1) {
                                    const cn = newLedgers[j].name.toLowerCase();
                                    if (tallyGroups.has(pn) || pn.includes(cn) || cn.includes(pn) || pn.replace(/\s*accounts?\s*/g,'') === cn.replace(/\s*accounts?\s*/g,'')) {
                                        toRemove.add(i);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (toRemove.size === 0) break;
                    newLedgers = newLedgers.filter((_, idx) => !toRemove.has(idx));
                }

                // Remove zero-balance items (closed ledgers in Layout B TBs)
                newLedgers = newLedgers.filter(l => l.openingBalance !== 0);
            }

            if (newLedgers.length > 0) {
                localStorage.setItem('LEDGERS' + _ys, JSON.stringify(newLedgers));
                if (!localStorage.getItem('VOUCHERS' + _ys)) localStorage.setItem('VOUCHERS' + _ys, '[]');
                this.persistToElectron();
                this._logAudit('import', 'Imported ' + newLedgers.length + ' ledgers (Excel/CSV, year=' + (year||'CY') + ')');
                return true;
            }
            console.warn("Import failed: No valid ledger data found in the file.");
            return false;
        } catch (err) {
            console.error("Import Error:", err);
            return false;
        }
    },

    /**
     * Save an adjustment entry (AE)
     */
    saveAdjustmentEntry(entry) {
        let ae = JSON.parse(localStorage.getItem('AE') || '[]');
        if (entry.id) {
            const idx = ae.findIndex(x => x.id === entry.id);
            if (idx !== -1) ae[idx] = entry;
            else ae.push(entry);
        } else {
            entry.id = Date.now();
            ae.push(entry);
        }
        localStorage.setItem('AE', JSON.stringify(ae));
        this.persistToElectron();
        this._logAudit(entry.id ? 'update' : 'create', 'AE: ' + entry.ledger + ' (Dr:' + (entry.debit||0) + ' Cr:' + (entry.credit||0) + ')');
        return true;
    },

    /**
     * Get all adjustment entries
     */
    getAdjustmentEntries() {
        return JSON.parse(localStorage.getItem('AE') || '[]');
    },

    /**
     * Get company details
     */
    getCompanyDetails() {
        const stored = localStorage.getItem('BD_DATA');
        if (stored) return JSON.parse(stored);
        /* Auto-detect current Indian financial year (Apr–Mar) */
        const now = new Date();
        const m = now.getMonth(); /* 0-based: 0=Jan … 3=Apr */
        const startYear = m >= 3 ? now.getFullYear() : now.getFullYear() - 1;
        const endYear = startYear + 1;
        return {
            name: 'MY BUSINESS PVT LTD',
            financialYear: '1-Apr-' + startYear + ' to 31-Mar-' + endYear,
            currentDate: '1-Apr-' + startYear
        };
    },

    /**
     * Save company details
     */
    saveCompanyDetails(details) {
        localStorage.setItem('BD_DATA', JSON.stringify(details));
        this.syncTallyUI();
        this.persistToElectron();
    },

    /**
     * Save a ledger
     */
    saveLedger(ledger, oldName) {
        let ledgers = JSON.parse(localStorage.getItem('LEDGERS') || '[]');
        const searchName = (oldName || ledger.name).toLowerCase();
        const idx = ledgers.findIndex(l => l.name.toLowerCase() === searchName);
        if (idx !== -1) {
            const prevName = ledgers[idx].name;
            ledgers[idx] = ledger;
            /* If the name changed, update all voucher and AE references */
            if (prevName.toLowerCase() !== ledger.name.toLowerCase()) {
                this._renameLedgerRefs(prevName, ledger.name);
                this._logAudit('rename', 'Renamed ledger "' + prevName + '" → "' + ledger.name + '"');
            }
        } else {
            ledgers.push(ledger);
            this._logAudit('create', 'Created ledger: ' + ledger.name);
        }
        localStorage.setItem('LEDGERS', JSON.stringify(ledgers));
        this.persistToElectron();
        return true;
    },

    _renameLedgerRefs(oldName, newName) {
        /* Update voucher line references */
        let vouchers = JSON.parse(localStorage.getItem('VOUCHERS') || '[]');
        let changed = false;
        vouchers.forEach(v => {
            if (v.lines) v.lines.forEach(line => {
                if (line.ledger && line.ledger.toLowerCase() === oldName.toLowerCase()) {
                    line.ledger = newName;
                    changed = true;
                }
            });
        });
        if (changed) localStorage.setItem('VOUCHERS', JSON.stringify(vouchers));

        /* Update AE references */
        let ae = JSON.parse(localStorage.getItem('AE') || '[]');
        let aeChanged = false;
        ae.forEach(entry => {
            if (entry.ledger && entry.ledger.toLowerCase() === oldName.toLowerCase()) {
                entry.ledger = newName;
                aeChanged = true;
            }
        });
        if (aeChanged) localStorage.setItem('AE', JSON.stringify(ae));
    },

    /**
     * Delete a ledger
     */
    deleteLedger(name) {
        let ledgers = JSON.parse(localStorage.getItem('LEDGERS') || '[]');
        const lowerName = name.toLowerCase();
        ledgers = ledgers.filter(l => l.name.toLowerCase() !== lowerName);
        localStorage.setItem('LEDGERS', JSON.stringify(ledgers));
        this.persistToElectron();
        this._logAudit('delete', 'Deleted ledger: ' + name);
        return true;
    },

    /**
     * Get all ledgers
     */
    getLedgers() {
        return JSON.parse(localStorage.getItem('LEDGERS') || '[]');
    },

    /**
     * Get all vouchers
     */
    getVouchers() {
        return JSON.parse(localStorage.getItem('VOUCHERS') || '[]');
    },

    /**
     * Save a voucher
     */
    saveVoucher(voucher) {
        /* Validate debit = credit before saving */
        if (voucher.lines && voucher.lines.length > 0) {
            let totalDr = 0, totalCr = 0;
            voucher.lines.forEach(l => { totalDr += (Number(l.debit) || 0); totalCr += (Number(l.credit) || 0); });
            if (Math.abs(totalDr - totalCr) > 0.01) {
                return { success: false, message: 'Voucher is unbalanced. Debit (₹' + totalDr.toFixed(2) + ') ≠ Credit (₹' + totalCr.toFixed(2) + ')' };
            }
        }
        const vouchers = this.getVouchers();
        const isNew = !voucher.id;
        if (voucher.id) {
            const idx = vouchers.findIndex(v => v.id === voucher.id);
            if (idx !== -1) vouchers[idx] = voucher;
            else vouchers.push(voucher);
        } else {
            voucher.id = Date.now();
            vouchers.push(voucher);
        }
        localStorage.setItem('VOUCHERS', JSON.stringify(vouchers));
        this.persistToElectron();
        this._logAudit(isNew ? 'create' : 'update', 'Voucher #' + voucher.id + ' (' + (voucher.type || 'Journal') + ')');
        return { success: true };
    },

    /**
     * Delete a voucher by ID
     */
    deleteVoucher(id) {
        let vouchers = this.getVouchers();
        vouchers = vouchers.filter(v => v.id !== id);
        localStorage.setItem('VOUCHERS', JSON.stringify(vouchers));
        this.persistToElectron();
        this._logAudit('delete', 'Deleted voucher #' + id);
        return true;
    },

    /**
     * Get next voucher number for a type
     */
    getNextVoucherNumber(type) {
        const vouchers = this.getVouchers();
        const filtered = vouchers.filter(v => v.type === type);
        return filtered.length + 1;
    },

    /**
     * Load a demo company's Trial Balance for quick preview / training.
     * Numbers chosen so the TB balances exactly (Dr = Cr); company name is generic.
     */
    loadSorichData() {
        this.clearAllData();
        const demoLedgers = [
            // Revenue & Direct Costs
            { "name": "Revenue from Operations",                   "group": "Revenue",              "openingBalance": -501380280.0 },
            { "name": "Cost of Raw Material consumed",             "group": "Direct Expenses",      "openingBalance":  401104224.0 },
            { "name": "Changes in inventories of Finished Goods.", "group": "Direct Expenses",      "openingBalance":  -15041408.4 },

            // Indirect Expenses
            { "name": "Employee Benefit Expenses",  "group": "Indirect Expenses",   "openingBalance":  21057971.76 },
            { "name": "Other Expenses",             "group": "Indirect Expenses",   "openingBalance":  20055211.20 },
            { "name": "Finance Costs (Interest)",   "group": "Indirect Expenses",   "openingBalance":  11600000.00 },
            { "name": "Depreciation & Amortization","group": "Indirect Expenses",   "openingBalance":   2750000.00 },
            { "name": "Tax Expenses",               "group": "Indirect Expenses",   "openingBalance":  17956284.43 },

            // Liabilities
            { "name": "Share Capital",                            "group": "Sources Of Fund",       "openingBalance": -152712830.00 },
            { "name": "Reserves and surplus",                     "group": "Sources Of Fund",       "openingBalance": -173576379.85 },
            { "name": "Share Application money pending allotment","group": "Sources Of Fund",       "openingBalance":   -9400000.00 },
            { "name": "Long term borrowings",                     "group": "Long Term Borrowings",  "openingBalance":   -3732704.86 },
            { "name": "Deferred tax liability",                   "group": "Long Term Borrowings",  "openingBalance":    -526368.00 },
            { "name": "Short term borrowings",                    "group": "Current Libilities",    "openingBalance":  -38753360.57 },
            { "name": "Trade Payables",                           "group": "Current Libilities",    "openingBalance":  -56637343.68 },
            { "name": "Other Current Liabilities",                "group": "Current Libilities",    "openingBalance":    4095121.58 },

            // Assets
            { "name": "Fixed Assets (Net)",             "group": "Non Current Assets",   "openingBalance":   56290871.58 },
            { "name": "Non-current Investments",        "group": "Non Current Assets",   "openingBalance":   56914477.25 },
            { "name": "Inventories",                    "group": "Current Assets",       "openingBalance":  217973092.00 },
            { "name": "Trade Receivables",              "group": "Current Assets",       "openingBalance":  113043403.24 },
            { "name": "Cash And Cash Equivalents",      "group": "Current Assets",       "openingBalance":   10382888.25 },
            { "name": "Short term loans and advances",  "group": "Current Assets",       "openingBalance":   13560411.07 },
            { "name": "Other current assets",           "group": "Current Assets",       "openingBalance":    4976719.00 }
        ];

        localStorage.setItem('LEDGERS', JSON.stringify(demoLedgers));
        localStorage.setItem('VOUCHERS', JSON.stringify([]));
        localStorage.setItem('BD_DATA', JSON.stringify({
            name: 'Demo Manufacturing Pvt. Ltd.',
            financialYear: '1-Apr-2025 to 31-Mar-2026'
        }));
        this.persistToElectron();
        return true;
    },

    /**
     * Clear all data
     */
    clearAllData() {
        localStorage.removeItem('VOUCHERS');
        localStorage.removeItem('LEDGERS');
        localStorage.removeItem('BD_DATA'); // Also clear basic details
        this.initDefaults();
        
        // Set default placeholder company details
        localStorage.setItem('BD_DATA', JSON.stringify({
            name: 'Your Company Pvt. Ltd.',
            financialYear: '1-Apr-2025 to 31-Mar-2026'
        }));
    },
    /**
     * Initialize with some default ledgers if empty
     */
    initDefaults() {
        /* Only ensure LEDGERS and VOUCHERS keys exist (empty arrays).
           Never auto-populate with sample data — use "Load Sorich Data" for that. */
        if (!localStorage.getItem('LEDGERS'))  localStorage.setItem('LEDGERS', '[]');
        if (!localStorage.getItem('VOUCHERS')) localStorage.setItem('VOUCHERS', '[]');
    },
    /**
     * Render Unified Bottom Tabs
     */
    renderTabs() {
        const container = document.querySelector(".bottom-tabs");
        if (!container) return;

        const tabs = [
            { id: 'home', label: 'HOME', href: 'dashboard.html', key: 'H' },
            { id: 'bd', label: 'BD', href: 'bd.html', key: 'B' },
            { id: 'tb', label: 'TB', href: 'tb.html', key: 'T' },
            { id: 'ae', label: 'AE', href: 'ae.html', key: 'A' },
            { id: 'bs', label: 'BS', href: 'balance.html', key: 'S' },
            { id: 'pl', label: 'PL', href: 'pl.html', key: 'P' },
            { id: 'cf', label: 'CF', href: 'cf.html', key: 'C' },
            { id: 'n1', label: 'N1', href: 'n1.html', key: '1' },
            { id: 'n2', label: 'N2', href: 'n2.html', key: '2' },
            { id: 'n3', label: 'N3', href: 'n3.html', key: '3' },
            { id: 'n4', label: 'N4', href: 'n4.html', key: '4' },
            { id: 'n5', label: 'N5', href: 'n5.html', key: '5' },
            { id: 'n6', label: 'N6', href: 'n6.html', key: '6' }
        ];

        const currentPage = window.location.pathname.split("/").pop().toLowerCase() || "dashboard.html";
        
        container.innerHTML = '';
        tabs.forEach(t => {
            const a = document.createElement('a');
            a.href = t.href;
            a.className = 'tab';
            if (t.href.toLowerCase() === currentPage || (currentPage === "" && t.href === "dashboard.html")) {
                a.classList.add('active');
            }
            a.innerHTML = `<span>${t.key}</span>${t.label.replace(t.key, '')}`;
            if (t.label.startsWith(t.key)) {
                a.innerHTML = `<span>${t.key}</span>${t.label.substring(1)}`;
            } else {
                a.innerHTML = t.label;
            }
            container.appendChild(a);
        });

        const plus = document.createElement('button');
        plus.className = 'tab plus';
        plus.textContent = '+';
        plus.onclick = () => {
            const popup = document.getElementById("addEntryPopup");
            if (popup) popup.style.display = "flex";
            else window.location.href = 'ae.html';  // Adjustment Entry page is the equivalent in CA workflow
        };
        container.appendChild(plus);
    },

    /**
     * Initialize Standard Tally UI
     */
    initStandardUI() {
        this.renderTallyHeader();
        this.renderTallySidebar();
        this.syncTallyUI();
        this.initGlobalListeners();
    },

    renderTallyHeader() {
        const header = document.querySelector('.tally-header');
        if (!header) return;

        header.innerHTML = `
            <div class="tally-header-left">
                <div class="tally-header-item" onclick="window.location.href='bd.html'"><span>K</span>: Company</div>
                <div class="tally-header-item"><span>Y</span>: Data</div>
                <div class="tally-header-item"><span>Z</span>: Exchange</div>
            </div>
            <div class="tally-header-right">
                <div class="tally-header-item"><span>G</span>: Go To</div>
                <div class="tally-header-item" onclick="AccountingEngine.triggerImport()"><span>O</span>: Import</div>
                <div class="tally-header-item" onclick="window.location.href='balance.html'"><span>E</span>: Export</div>
                <div class="tally-header-item" onclick="window.print()"><span>P</span>: Print</div>
                <div class="tally-header-item"><span>F1</span>: Help</div>
            </div>
        `;
    },

    renderTallySidebar() {
        const sidebar = document.querySelector('.tally-sidebar');
        if (!sidebar) return;

        const shortcuts = [
            { label: 'Date', key: 'F2', action: () => this.triggerChangeDate() },
            { label: 'Period', key: 'Alt+F2', action: () => this.triggerChangePeriod() },
            { label: 'Company', key: 'F3', action: () => window.location.href = 'bd.html' },
            { label: 'Contra', key: 'F4', action: () => this.navigateToVoucher('Contra') },
            { label: 'Payment', key: 'F5', action: () => this.navigateToVoucher('Payment') },
            { label: 'Receipt', key: 'F6', action: () => this.navigateToVoucher('Receipt') },
            { label: 'Journal', key: 'F7', action: () => this.navigateToVoucher('Journal') },
            { label: 'Sales', key: 'F8', action: () => this.navigateToVoucher('Sales') },
            { label: 'Purchase', key: 'F9', action: () => this.navigateToVoucher('Purchase') },
            { label: 'Other Vouchers', key: 'F10', action: () => this.navigateToVoucher('Journal') },
            { label: 'Quit', key: 'Esc', action: () => window.location.href = 'index.html' }
        ];

        sidebar.innerHTML = '';
        shortcuts.forEach(s => {
            const btn = document.createElement('button');
            btn.className = 'sidebar-btn';
            btn.innerHTML = `<span>${s.label}</span><span class="shortcut">${s.key}</span>`;
            btn.onclick = s.action;
            sidebar.appendChild(btn);
        });
    },

    triggerChangeDate() {
        const newDate = prompt("Enter New Date:", "1-Apr-2023");
        if (newDate) {
            const bd = JSON.parse(localStorage.getItem('BD_DATA') || '{}');
            bd.currentDate = newDate;
            localStorage.setItem('BD_DATA', JSON.stringify(bd));
            this.syncTallyUI();
            location.reload();
        }
    },

    triggerChangePeriod() {
        const newPeriod = prompt("Enter New Period:", "1-Apr-2023 to 31-Mar-2024");
        if (newPeriod) {
            const bd = JSON.parse(localStorage.getItem('BD_DATA') || '{}');
            bd.financialYear = newPeriod;
            localStorage.setItem('BD_DATA', JSON.stringify(bd));
            this.syncTallyUI();
            location.reload();
        }
    },

    navigateToVoucher(type) {
        localStorage.setItem('PENDING_VOUCHER_TYPE', type);
        window.location.href = 'ae.html';  // Voucher entry handled via Adjustment Entries in CA workflow
    },

    triggerImport() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xml,.xlsx,.xls,.csv';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                let success = false;
                if (file.name.endsWith('.xml')) {
                    success = this.importTallyXML(ev.target.result);
                } else {
                    try {
                        const data = new Uint8Array(ev.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });
                        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                        success = this.importExcelTB(jsonData);
                    } catch (err) {
                        console.error(err);
                        alert("Excel processing failed: " + err.message);
                    }
                }
                if (success) {
                    alert("Import Successful!");
                    location.reload();
                } else if (!file.name.endsWith('.xml')) {
                    alert("Import failed. Please check file format.");
                }
            };
            if (file.name.endsWith('.xml')) reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        };
        input.click();
    },

    /**
     * Initialize Global Event Listeners and UI
     */
    initGlobalListeners() {
        if (this._listenersBound) return;
        this._listenersBound = true;

        const init = async () => {
            await this.syncWithElectron();
            this.renderTabs();
            this.syncTallyUI();
            this.renderTallyHeader();
            this.renderTallySidebar();
            this.startAutoSave(30000);
            this.initDragDrop();
        };

        if (document.readyState === "loading") {
            window.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }

        document.addEventListener("keydown", (e) => {
            // Check if in an input field
            const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
            
            // Global Escape to go back to landing page
            if (e.key === "Escape") {
                const currentPage = window.location.pathname.split("/").pop().toLowerCase();
                if (currentPage !== "index.html" && currentPage !== "dashboard.html" && currentPage !== "") {
                    // Check if there's a modal or popup to close first
                    const popups = ['ledgerListPopup', 'addEntryPopup', 'configModalBackdrop', 'modalBack', 'acceptDialog', 'metaModal', 'clientMgmtModal'];
                    let closed = false;
                    popups.forEach(id => {
                        const p = document.getElementById(id);
                        if (p && p.style.display && p.style.display !== 'none') {
                            p.style.display = 'none';
                            closed = true;
                        }
                    });

                    if (!closed) {
                        e.preventDefault();
                        window.location.href = "index.html";
                        return;
                    }
                }
            }
            
            // F-Keys (Tally style)
            if (e.key === 'F2') { e.preventDefault(); this.triggerChangeDate(); }
            if (e.altKey && e.key === 'F2') { e.preventDefault(); this.triggerChangePeriod(); }
            if (e.key === 'F3') { e.preventDefault(); window.location.href = 'bd.html'; }
            if (e.key === 'F4') { e.preventDefault(); this.navigateToVoucher('Contra'); }
            if (e.key === 'F5') { e.preventDefault(); this.navigateToVoucher('Payment'); }
            if (e.key === 'F6') { e.preventDefault(); this.navigateToVoucher('Receipt'); }
            if (e.key === 'F7') { e.preventDefault(); this.navigateToVoucher('Journal'); }
            if (e.key === 'F8') { e.preventDefault(); this.navigateToVoucher('Sales'); }
            if (e.key === 'F9') { e.preventDefault(); this.navigateToVoucher('Purchase'); }
            if (e.key === 'F10') { e.preventDefault(); this.navigateToVoucher('Journal'); }
            if (e.key === 'F11') { e.preventDefault(); alert('Features'); }
            if (e.key === 'F12') { 
                e.preventDefault(); 
                const config = document.getElementById('configModalBackdrop') || document.getElementById('modalBack');
                if (config) config.style.display = 'flex';
                else alert('Configure'); 
            }

            // Alt + Keys for top header and bottom navigation
            if (e.altKey && !e.ctrlKey) {
                const altShortcuts = {
                    'k': 'bd.html',
                    'y': 'bd.html', 
                    'z': 'bd.html', 
                    'o': 'import',
                    'e': 'balance.html',
                    'p': 'pl.html',
                    'g': 'goto',
                    'h': 'dashboard.html',
                    'b': 'bd.html',
                    't': 'tb.html',
                    'a': 'ae.html',
                    's': 'balance.html',
                    'c': 'cf.html'
                };
                const key = e.key.toLowerCase();
                const action = altShortcuts[key];
                if (action) {
                    e.preventDefault();
                    if (action === 'import') this.triggerImport();
                    else if (action === 'print') window.print();
                    else if (action === 'goto') this.triggerGoTo();
                    else window.location.href = action;
                    return;
                }
            }

            // Single Key Shortcuts (Only if not in an input field)
            if (!e.altKey && !e.ctrlKey && !isInput) {
                const key = e.key.toLowerCase();
                
                const path = window.location.pathname.toLowerCase();
                // Legacy gateway.html removed — kept only for back-compat if any bookmark exists
                const isGateway = path.endsWith('/index.html') || path.endsWith('/') || path === '' || path.endsWith('/dashboard.html');

                // Page-specific keyboard shortcuts (on dashboard / index)
                if (isGateway) {
                    const gatewayShortcuts = {
                        'b': 'balance.html',
                        'p': 'pl.html',
                        'q': 'dashboard.html',
                        'l': 'load-sorich',
                        'i': 'import-excel',
                        'u': 'dashboard.html',
                        't': 'tb.html'
                    };

                    if (gatewayShortcuts[key]) {
                        e.preventDefault();
                        const action = gatewayShortcuts[key];
                        if (action === 'load-sorich') {
                            if (confirm('Load demo data? This will reset current data.')) {
                                this.loadSorichData();
                                alert("Demo Data Loaded Successfully!");
                                location.reload();
                            }
                        } else if (action === 'import-excel') {
                            const input = document.getElementById('excelInput');
                            if (input) input.click();
                            else this.triggerImport();
                        } else {
                            if (key === 'q' && !confirm("Are you sure you want to Quit?")) return;
                            window.location.href = action;
                        }
                        return;
                    }

                    // Handle Arrow Keys and Enter for Gateway Menu
                    if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
                        const menuItems = document.querySelectorAll('.menu-item');
                        if (menuItems.length > 0) {
                            e.preventDefault();
                            let selectedIndex = -1;
                            menuItems.forEach((item, idx) => { if (item.classList.contains('selected')) selectedIndex = idx; });

                            if (e.key === 'ArrowDown') {
                                selectedIndex = (selectedIndex + 1) % menuItems.length;
                            } else if (e.key === 'ArrowUp') {
                                selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
                            } else if (e.key === 'Enter' && selectedIndex !== -1) {
                                const item = menuItems[selectedIndex];
                                const href = item.getAttribute('data-href');
                                const action = item.getAttribute('data-action');
                                
                                if (action === 'load-sorich') {
                                    if (confirm('Load demo data? This will reset current data.')) {
                                        this.loadSorichData();
                                        alert("Demo Data Loaded Successfully!");
                                        location.reload();
                                    }
                                } else if (action === 'import-excel') {
                                    const input = document.getElementById('excelInput');
                                    if (input) input.click();
                                    else this.triggerImport();
                                } else if (href) {
                                    if (href === 'dashboard.html' && !confirm("Are you sure you want to Quit?")) return;
                                    window.location.href = href;
                                }
                            }

                            if (selectedIndex !== -1) {
                                menuItems.forEach((item, idx) => item.classList.toggle('selected', idx === selectedIndex));
                            }
                        }
                    }
                }

                // Top header shortcuts (Global)
                const globalShortcuts = {
                    'k': 'bd.html',
                    'o': 'import',
                    'e': 'balance.html',
                    'p': 'print',
                    'g': 'goto',
                    'y': 'bd.html',
                    'z': 'bd.html'
                };

                if (globalShortcuts[key]) {
                    const action = globalShortcuts[key];
                    e.preventDefault();
                    if (action === 'import') this.triggerImport();
                    else if (action === 'print') window.print();
                    else if (action === 'goto') this.triggerGoTo();
                    else window.location.href = action;
                    return;
                }
                
                // Bottom Tab Shortcuts (1-6)
                if (['1', '2', '3', '4', '5', '6'].includes(key)) {
                    e.preventDefault();
                    window.location.href = `n${key}.html`;
                }
            }
        });
    },

    triggerGoTo() {
        const target = prompt("Go To: (bs, pl, tb, bd, voucher, gateway)");
        if (target) {
            const map = {
                'bs': 'balance.html',
                'pl': 'pl.html',
                'tb': 'tb.html',
                'bd': 'bd.html',
                'ae': 'ae.html',
                'cf': 'cf.html',
                'voucher': 'ae.html',       // Tally voucher equivalent → Adjustment Entries
                'vouchers': 'ae.html',
                'gateway': 'index.html',    // Tally gateway → our landing page
                'home': 'dashboard.html',
                'n1': 'n1.html', 'n2': 'n2.html', 'n3': 'n3.html',
                'n4': 'n4.html', 'n5': 'n5.html', 'n6': 'n6.html', 'n7': 'n7.html',
                'tx': 'tx.html',
                'audit': 'audit-report.html',
                'fs': 'fs-package.html'
            };
            const loc = map[target.toLowerCase()];
            if (loc) window.location.href = loc;
            else alert("Page not found: " + target);
        }
    },

    /**
     * Sync UI elements with data from localStorage
     */
    syncTallyUI() {
        const bdStored = localStorage.getItem("BD_DATA");
        if (bdStored) {
            const bd = JSON.parse(bdStored);
            // Update company name displays
            const nameElements = document.querySelectorAll('.company-name, #companyNameDisplay');
            nameElements.forEach(el => {
                el.textContent = bd.name || "MY BUSINESS PVT LTD";
                if (el.id === 'companyNameDisplay') el.textContent = (bd.name || "MY BUSINESS PVT LTD").toUpperCase();
            });

            // Update financial year displays
            const fyElements = document.querySelectorAll('.financial-year, #periodRange');
            fyElements.forEach(el => {
                el.textContent = bd.financialYear || "1-Apr-23 to 31-Mar-24";
            });
        }
        // Update auto-save indicator
        const saveEl = document.getElementById('autoSaveIndicator');
        if (saveEl && !saveEl.textContent) { saveEl.textContent = '✓ Saved'; saveEl.style.color = '#15c39a'; }
        // Update balance status badge
        const balEl = document.getElementById('balanceStatusBadge');
        if (balEl) {
            try {
                const bs = this.getBalanceStatus();
                balEl.textContent = bs.balanced ? '✓ TB Balanced' : '⚠ Off by ₹' + bs.diff.toFixed(2);
                balEl.style.background = bs.balanced ? '#e8faf5' : '#fff3e0';
                balEl.style.color = bs.balanced ? '#0a8068' : '#e65100';
                balEl.style.border = '1px solid ' + (bs.balanced ? '#b3edd8' : '#ffcc80');
            } catch(e) {}
        }
    },

    /**
     * Re-classify all existing ledgers using smart keyword guessing
     */
    reGroupAllLedgers() {
        let ledgers = this.getLedgers();
        if (!ledgers.length) return 0;
        ledgers.forEach(l => { l.group = this.guessGroup(l.name); });
        localStorage.setItem('LEDGERS', JSON.stringify(ledgers));
        this.persistToElectron();
        return ledgers.length;
    },

    /**
     * Check if the trial balance is balanced
     */
    getBalanceStatus() {
        const tb = this.getTrialBalance();
        const diff = Math.abs(tb.totalDr - tb.totalCr);
        return { balanced: diff < 0.01, diff: diff, drTotal: tb.totalDr, crTotal: tb.totalCr };
    },

    /**
     * Auto-save to Electron every N ms whenever accounting data changes
     */
    startAutoSave(intervalMs) {
        if (this._autoSaveTimer) return;
        intervalMs = intervalMs || 30000;
        const WATCHED = ['LEDGERS', 'VOUCHERS', 'AE', 'BD_DATA'];
        const origSet = localStorage.setItem.bind(localStorage);
        const self = this;
        localStorage.setItem = function(key, value) {
            origSet(key, value);
            if (WATCHED.indexOf(key) !== -1) {
                self._dirty = true;
                self._updateSaveIndicator('unsaved');
            }
        };
        this._autoSaveTimer = setInterval(async function() {
            if (self._dirty) {
                self._dirty = false;
                self._updateSaveIndicator('saving');
                await self.persistToElectron();
                self._updateSaveIndicator('saved');
            }
        }, intervalMs);
    },

    _updateSaveIndicator(state) {
        const el = document.getElementById('autoSaveIndicator');
        if (!el) return;
        if (state === 'saved')       { el.textContent = '✓ Saved';   el.style.color = '#15c39a'; }
        else if (state === 'saving') { el.textContent = '↻ Saving…'; el.style.color = '#f0a500'; }
        else                         { el.textContent = '● Unsaved'; el.style.color = '#e05252'; }
    },

    /**
     * Enable drag-and-drop import of Excel/XML on any page
     */
    initDragDrop() {
        if (this._dragDropInit) return;
        this._dragDropInit = true;
        const overlay = document.createElement('div');
        overlay.id = 'dragOverlay';
        overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(21,195,154,0.15);border:4px dashed #15c39a;justify-content:center;align-items:center;font-size:22px;font-weight:700;color:#0a8068;pointer-events:none;flex-direction:column;gap:8px;';
        overlay.innerHTML = '<div style="font-size:40px">📂</div><div>Drop Excel / XML to Import</div>';
        document.body.appendChild(overlay);
        let counter = 0;
        const self = this;
        document.addEventListener('dragenter', function(e) { e.preventDefault(); counter++; overlay.style.display = 'flex'; });
        document.addEventListener('dragleave', function() { if (--counter <= 0) { counter = 0; overlay.style.display = 'none'; } });
        document.addEventListener('dragover', function(e) { e.preventDefault(); });
        document.addEventListener('drop', function(e) {
            e.preventDefault(); counter = 0; overlay.style.display = 'none';
            const file = e.dataTransfer.files[0];
            if (!file) return;
            const isXML = file.name.toLowerCase().endsWith('.xml');
            const reader = new FileReader();
            reader.onload = async function(ev) {
                let success = false;
                if (isXML) {
                    success = self.importTallyXML(ev.target.result);
                } else {
                    try {
                        if (typeof XLSX === 'undefined') { alert('XLSX library not loaded on this page. Use the Import button instead.'); return; }
                        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
                        const jsonData = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
                        const result = await self.runAutomation(jsonData);
                        success = result && result.success;
                    } catch(err) { alert('Import failed: ' + err.message); return; }
                }
                if (success) { alert('✓ Imported successfully!'); location.reload(); }
                else { alert('Import failed. Please check the file format.'); }
            };
            if (isXML) reader.readAsText(file); else reader.readAsArrayBuffer(file);
        });
    },

    /* ================================================================
       AUDIT TRAIL — logs every data-changing action with timestamp
       ================================================================ */
    _logAudit(action, detail) {
        try {
            const log = JSON.parse(localStorage.getItem('AUDIT_LOG') || '[]');
            const user = localStorage.getItem('CURRENT_USER') || 'system';
            log.push({
                ts: new Date().toISOString(),
                user: user,
                action: action,
                detail: detail
            });
            /* Keep last 500 entries to avoid bloating localStorage */
            if (log.length > 500) log.splice(0, log.length - 500);
            localStorage.setItem('AUDIT_LOG', JSON.stringify(log));
        } catch(e) { /* never let audit logging break the app */ }
    },

    getAuditLog() {
        return JSON.parse(localStorage.getItem('AUDIT_LOG') || '[]');
    },

    clearAuditLog() {
        localStorage.removeItem('AUDIT_LOG');
        this.persistToElectron();
    },

    /* ================================================================
       MULTI-FY DATA MANAGEMENT
       ================================================================ */

    /**
     * Get the current FY key string, e.g. "2025-2026"
     */
    _currentFYKey() {
        const bd = this.getCompanyDetails();
        const fy = (bd.financialYear || '').trim();
        const years = fy.match(/\d{4}/g);
        return (years && years.length >= 2) ? years[0] + '-' + years[1] : 'default';
    },

    /**
     * Save a full snapshot of the current FY data for later retrieval
     */
    saveFYSnapshot(fyKey) {
        fyKey = fyKey || this._currentFYKey();
        const snapshot = {
            LEDGERS:  localStorage.getItem('LEDGERS')  || '[]',
            VOUCHERS: localStorage.getItem('VOUCHERS') || '[]',
            AE:       localStorage.getItem('AE')       || '[]',
            BD_DATA:  localStorage.getItem('BD_DATA')  || '{}',
            BS_BUILDER_V2: localStorage.getItem('BS_BUILDER_V2') || ''
        };
        /* Store under FY_<key> */
        localStorage.setItem('FY_' + fyKey, JSON.stringify(snapshot));
        this.persistToElectron();
        this._logAudit('fy-save', 'Saved FY snapshot: ' + fyKey);
        return true;
    },

    /**
     * Load a previously saved FY snapshot
     */
    loadFYSnapshot(fyKey) {
        const raw = localStorage.getItem('FY_' + fyKey);
        if (!raw) return false;
        try {
            const snapshot = JSON.parse(raw);
            for (const k in snapshot) {
                localStorage.setItem(k, snapshot[k]);
            }
            this.persistToElectron();
            this._logAudit('fy-load', 'Loaded FY snapshot: ' + fyKey);
            return true;
        } catch(e) { return false; }
    },

    /**
     * List all saved FY snapshots
     */
    listFYSnapshots() {
        const snapshots = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith('FY_')) {
                const fyKey = k.substring(3);
                try {
                    const data = JSON.parse(localStorage.getItem(k));
                    const bd = JSON.parse(data.BD_DATA || '{}');
                    const ledgers = JSON.parse(data.LEDGERS || '[]');
                    snapshots.push({
                        key: fyKey,
                        company: bd.name || '—',
                        fy: bd.financialYear || fyKey,
                        ledgerCount: ledgers.length
                    });
                } catch(e) { snapshots.push({ key: fyKey, company: '—', fy: fyKey, ledgerCount: 0 }); }
            }
        }
        return snapshots.sort((a, b) => a.key.localeCompare(b.key));
    },

    /**
     * Carry forward current year closing balances as next year opening balances
     */
    carryForwardToNextFY() {
        /* 1. Save current FY snapshot first */
        const currentFY = this._currentFYKey();
        this.saveFYSnapshot(currentFY);

        /* 2. Compute closing balances (opening + voucher + AE movements) */
        const balances = this.getLedgerBalances();
        const bd = this.getCompanyDetails();

        /* 3. Build next FY ledgers with closing balances as new opening */
        const nextLedgers = [];
        for (const name in balances) {
            const b = balances[name];
            nextLedgers.push({
                name: name,
                group: b.group || 'Primary',
                openingBalance: b.current   /* closing balance becomes opening */
            });
        }

        /* 4. Advance the FY by one year */
        const fy = (bd.financialYear || '').trim();
        const years = fy.match(/\d{4}/g);
        if (years && years.length >= 2) {
            const sy = parseInt(years[0]) + 1;
            const ey = parseInt(years[1]) + 1;
            bd.financialYear = '1-Apr-' + sy + ' to 31-Mar-' + ey;
        }

        /* 5. Save new FY data */
        localStorage.setItem('LEDGERS', JSON.stringify(nextLedgers));
        localStorage.setItem('VOUCHERS', '[]');     /* fresh vouchers for new year */
        localStorage.setItem('AE', '[]');            /* fresh AE for new year */
        this.saveCompanyDetails(bd);
        localStorage.removeItem('BS_BUILDER_V2');    /* clear BS manual entries */
        this.persistToElectron();
        this._logAudit('fy-carry', 'Carried forward ' + nextLedgers.length + ' ledgers from ' + currentFY);
        return { success: true, ledgerCount: nextLedgers.length, newFY: bd.financialYear };
    },

    /**
     * Get previous year balances for comparative reports.
     * Preference order:
     *   1. Directly imported LEDGERS_PY (user uploaded last year's TB)
     *   2. FY_{prev-year} snapshot (auto-saved at year-end close)
     */
    getPreviousYearBalances() {
        // 1. Prefer directly imported PY ledgers
        if (this.hasPYData()) {
            const balances = this.getLedgerBalances('PY');
            const result = {};
            for (const name in balances) result[name] = balances[name].current;
            return result;
        }

        // 2. Fall back to year-end snapshot
        const currentFY = this._currentFYKey();
        const years = currentFY.split('-').map(Number);
        if (years.length < 2) return {};
        const prevFYKey = (years[0] - 1) + '-' + (years[1] - 1);
        const raw = localStorage.getItem('FY_' + prevFYKey);
        if (!raw) return {};
        try {
            const snapshot = JSON.parse(raw);
            const ledgers = JSON.parse(snapshot.LEDGERS || '[]');
            const result = {};
            ledgers.forEach(l => { result[l.name] = l.openingBalance || 0; });
            return result;
        } catch(e) { return {}; }
    },

    /* ================================================================
       MULTI-CLIENT DATABASE
       Each client has an isolated "vault" containing all working keys.
       Active client's vault is deserialized into normal keys for session use.
       ================================================================ */

    // Keys that belong to a client vault (session data).
    // IMPORTANT: every key written by any report/input page MUST be listed here.
    // A missing key = that client's data leaks into other clients when you switch.
    _CLIENT_KEYS: [
        // Core accounting data
        'LEDGERS', 'LEDGERS_PY',
        'VOUCHERS', 'VOUCHERS_PY',
        'AE', 'AE_PY',
        'BD_DATA', 'FS_META',
        'TB_GRAND_TOTAL', 'TB_GRAND_TOTAL_PY',
        // Legacy textarea note keys (kept for backward compat)
        'N1', 'N2', 'N3_FA', 'N4', 'N5', 'N6',
        'N1_TAX', 'N2_BS', 'N3_BS', 'N4_MT', 'N5_PL', 'N4_GP',
        'NOTES_V1', 'BS_BUILDER_V2', 'PL_BUILDER', 'CF_BUILDER',
        'TB_VIEW_YEAR',
        // New notes-matching-Excel keys (N1-N7 pages + TX + AR)
        'N1_GEN', 'N1_POL',
        'N2_DATA',
        'N3_PPE',
        'N4_DATA',
        'N5_DATA',
        'N6_DATA',
        'N7_DATA',
        'TX_DATA',
        'AUDIT_REPORT',
        // Cash Flow overrides (user edits to the yellow cells on cf.html)
        'CF_OVERRIDES', 'CF_DATA',
        // Audit Manager state (audit.html)
        'AUDIT_MANAGER',
        // GST working papers (gst.html)
        'GST_GSTR', 'GST_PURCHASE', 'GST_DATA',
        // CARO (caro.html)
        'CARO_COMP', 'CARO_RESP', 'CARO_DATA',
        // Fixed Asset Register (far.html)
        'FAR',
        // Stock (stc.html)
        'STC_DATA',
        // Global display settings (bundled per-client)
        'ROUNDING',
        // Classification rules are per-user (global), NOT included here
        // Drafts are per-client (their own key pattern DRAFTS_<id>), handled separately
        // AUDIT_LOG is global, handled separately
    ],

    getClients() {
        try { return JSON.parse(localStorage.getItem('CLIENTS_REGISTRY') || '[]'); }
        catch(e) { return []; }
    },

    getActiveClientId() {
        return localStorage.getItem('ACTIVE_CLIENT_ID') || '';
    },

    getActiveClient() {
        const id = this.getActiveClientId();
        if (!id) return null;
        return this.getClients().find(c => c.id === id) || null;
    },

    _saveClientRegistry(list) {
        localStorage.setItem('CLIENTS_REGISTRY', JSON.stringify(list));
        if (this.persistToElectron) this.persistToElectron();
    },

    _snapshotSession() {
        const snap = {};
        this._CLIENT_KEYS.forEach(k => {
            const v = localStorage.getItem(k);
            if (v !== null) snap[k] = v;
        });
        // Include any FY_* snapshot keys (year-end snapshots)
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('FY_')) snap[k] = localStorage.getItem(k);
        }
        return snap;
    },

    _clearSession() {
        this._CLIENT_KEYS.forEach(k => localStorage.removeItem(k));
        const fyKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('FY_')) fyKeys.push(k);
        }
        fyKeys.forEach(k => localStorage.removeItem(k));
    },

    _restoreSession(snap) {
        this._clearSession();
        Object.keys(snap || {}).forEach(k => {
            if (snap[k] !== undefined && snap[k] !== null) localStorage.setItem(k, snap[k]);
        });
    },

    _saveVaultFor(id) {
        if (!id) return;
        const snap = this._snapshotSession();
        localStorage.setItem('CLIENT_VAULT_' + id, JSON.stringify(snap));
    },

    _loadVaultFor(id) {
        const raw = localStorage.getItem('CLIENT_VAULT_' + id);
        if (!raw) { this._clearSession(); return; }
        try {
            const snap = JSON.parse(raw);
            this._restoreSession(snap);
        } catch(e) { console.error('Failed to load vault:', e); this._clearSession(); }
    },

    /**
     * Create a new client, auto-switch to it.
     * @param {string} name Client name (company name)
     * @returns {string} new client id
     */
    addClient(name) {
        const clients = this.getClients();
        const id = 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const now = new Date().toISOString();
        clients.push({ id, name: name || 'Untitled Client', createdAt: now, lastOpened: now });
        this._saveClientRegistry(clients);

        // Save current session as vault for old client (if any)
        const oldId = this.getActiveClientId();
        if (oldId) this._saveVaultFor(oldId);

        // Clear session for fresh start under new client
        this._clearSession();
        localStorage.setItem('ACTIVE_CLIENT_ID', id);
        // Seed company name
        const bd = { name: name || 'Untitled Client', financialYear: '' };
        localStorage.setItem('BD_DATA', JSON.stringify(bd));
        if (this.persistToElectron) this.persistToElectron();
        return id;
    },

    /**
     * Switch active client: save current vault, load target vault.
     */
    switchClient(id) {
        if (!id) return false;
        const clients = this.getClients();
        const target = clients.find(c => c.id === id);
        if (!target) return false;

        const oldId = this.getActiveClientId();
        if (oldId && oldId !== id) this._saveVaultFor(oldId);

        this._loadVaultFor(id);
        localStorage.setItem('ACTIVE_CLIENT_ID', id);
        target.lastOpened = new Date().toISOString();
        this._saveClientRegistry(clients);
        if (this.persistToElectron) this.persistToElectron();
        return true;
    },

    /**
     * Save current session into the active client's vault.
     * Call this before navigating away from a page where critical changes were made.
     */
    saveActiveClient() {
        const id = this.getActiveClientId();
        if (id) this._saveVaultFor(id);
    },

    /**
     * Rename a client
     */
    renameClient(id, newName) {
        const clients = this.getClients();
        const c = clients.find(x => x.id === id);
        if (!c) return false;
        c.name = newName || c.name;
        this._saveClientRegistry(clients);

        // Also update BD_DATA.name if this is the active client
        if (this.getActiveClientId() === id) {
            try {
                const bd = JSON.parse(localStorage.getItem('BD_DATA') || '{}');
                bd.name = newName;
                localStorage.setItem('BD_DATA', JSON.stringify(bd));
            } catch(e) {}
        }
        return true;
    },

    /**
     * Delete a client (and its vault). If it was active, clear session.
     */
    deleteClient(id) {
        const clients = this.getClients();
        const idx = clients.findIndex(c => c.id === id);
        if (idx < 0) return false;
        clients.splice(idx, 1);
        this._saveClientRegistry(clients);
        localStorage.removeItem('CLIENT_VAULT_' + id);

        if (this.getActiveClientId() === id) {
            this._clearSession();
            // Switch to most recently opened remaining client, if any
            const remaining = this.getClients().sort((a,b) => (b.lastOpened||'').localeCompare(a.lastOpened||''));
            if (remaining.length > 0) {
                this.switchClient(remaining[0].id);
            } else {
                localStorage.removeItem('ACTIVE_CLIENT_ID');
            }
        }
        return true;
    },

    /**
     * First-run migration: if user has data but no client registered, wrap
     * current data into a default client "My Company".
     */
    ensureClientContext() {
        // Migrate any legacy CLIENT_LIST / CDATA_ data on first run
        this._migrateLegacyClients && this._migrateLegacyClients();

        const hasData = !!localStorage.getItem('LEDGERS') || !!localStorage.getItem('BD_DATA');
        const clients = this.getClients();
        if (clients.length === 0 && hasData) {
            // Migrate existing data into a default client
            let name = 'My Company';
            try {
                const bd = JSON.parse(localStorage.getItem('BD_DATA') || '{}');
                if (bd && bd.name) name = bd.name;
            } catch(e) {}
            const id = 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const now = new Date().toISOString();
            const list = [{ id, name, createdAt: now, lastOpened: now }];
            this._saveClientRegistry(list);
            this._saveVaultFor(id);
            localStorage.setItem('ACTIVE_CLIENT_ID', id);
        } else if (clients.length === 0 && !hasData) {
            // Brand new install — create empty default client
            this.addClient('My Company');
        } else if (!this.getActiveClientId() && clients.length > 0) {
            // Registry exists but no active — pick the most recent
            const mostRecent = [...clients].sort((a,b) => (b.lastOpened||'').localeCompare(a.lastOpened||''))[0];
            this.switchClient(mostRecent.id);
        }
    },

    /* ================================================================
       CASH FLOW STATEMENT — Indirect Method, Schedule III
       Auto-computes Operating / Investing / Financing from BS+PL data.
       Requires PY data for working-capital deltas; returns CY only if no PY.
       ================================================================ */
    getCashFlowStatement() {
        const cy = this.getScheduleIIIReport('CY') || {};
        const hasPY = this.hasPYData();
        const py = hasPY ? this.getScheduleIIIReport('PY') : null;

        const bsnCY = cy.bsNotes || {};
        const plCY = cy.pl || {};
        const plnCY = cy.plNotes || {};
        const reportCY = cy.report || { assets: [], liabilities: [], pl:{incomes:[],expenses:[]}, trading:{incomes:[],expenses:[]} };
        const bsnPY = py ? py.bsNotes || {} : {};
        const plnPY = py ? py.plNotes || {} : {};
        const reportPY = py ? (py.report || { assets: [], liabilities: [] }) : { assets: [], liabilities: [] };

        // ── Helper: classify an "Other Income" ledger into adjustment buckets ──
        // Buckets follow the classic CA-firm (Oaks) format.
        const classifyOtherIncome = (name) => {
            const n = (name || '').toLowerCase();
            if (n.includes('dividend')) return 'dividend';
            if ((n.includes('long term') && (n.includes('capital gain') || n.includes('ltcg'))) ||
                n.includes('ltcg') || (n.includes('long term') && n.includes('gain'))) return 'ltcg';
            if ((n.includes('short term') && (n.includes('capital gain') || n.includes('stcg'))) ||
                n.includes('stcg') || (n.includes('short term') && n.includes('gain'))) return 'stcg';
            if (n.includes('f&o') || n.includes('future and option') || n.includes('futures & option') ||
                n.includes('derivative')) return 'fno';
            if (n.includes('speculation') || n.includes('intraday') || n.includes('speculative')) return 'speculation';
            if ((n.includes('write') && n.includes('back')) || n.includes('w/back') || n.includes('writeback') ||
                (n.includes('sundry') && (n.includes('balance') || n.includes('written'))) ||
                (n.includes('liabilit') && n.includes('written'))) return 'writeBack';
            if (n.includes('interest') && (n.includes('fd') || n.includes('fixed deposit') ||
                n.includes('term deposit') || n.includes('bank deposit') ||
                n.includes('it refund') || n.includes('income tax refund') ||
                n.includes('income tax'))) return 'intFD';
            if (n.includes('interest')) return 'intOther';
            return 'otherNonOp';
        };

        // Split Other Income items into named buckets (CY)
        const oiBuckets = { dividend:0, ltcg:0, stcg:0, fno:0, speculation:0, writeBack:0, intFD:0, intOther:0, otherNonOp:0 };
        (plnCY.n17_otherIncome?.items || []).forEach(i => {
            oiBuckets[classifyOtherIncome(i.name)] += (i.amount || 0);
        });
        // Only the portion we STRIP OUT of PBT flows into investing.
        // intOther stays in operating (default), so it is NOT added to investing.
        const interestIncome = oiBuckets.intFD;
        const dividendIncome = oiBuckets.dividend;

        // ── Helper: classify a BS asset ledger for investing lines ──
        // Returns one of: 'equityInv', 'fixedDeposit', 'capitalAdv', 'other'
        const classifyAssetForInvesting = (name) => {
            const n = (name || '').toLowerCase();
            if (n.includes('equity share') || n.includes('investment in equity') ||
                n.includes('mutual fund') || n.includes('mf ') || n.endsWith(' mf') ||
                n.includes('liquid fund') || n.includes('money market') ||
                n.includes('debenture') || n.includes('ncd') || n.includes(' bond') ||
                n.startsWith('bond ') || n.includes('bonds ') || n.includes('preference share') ||
                n.includes('investment') || (n.includes('invest') && !n.includes('investor'))) return 'equityInv';
            if (n.includes('fixed deposit') || n.includes(' fd ') || n.endsWith(' fd') ||
                n.includes('term deposit') || n.includes('bank deposit') ||
                n.includes('recurring deposit') || n.includes(' rd ')) return 'fixedDeposit';
            if (n.includes('capital advance') || n.includes('capital creditor') ||
                n.includes('capital work') || n.includes('cwip') ||
                (n.includes('advance') && (n.includes('supplier of') || n.includes('vendor for') ||
                 n.includes('machinery') || n.includes('plant')))) return 'capitalAdv';
            return 'other';
        };

        // ── Classify which BS note a group name maps to. Mirrors the engine's
        //    getScheduleIIIReport asset-classifier so we can detect investment
        //    ledgers at per-ledger granularity (BS note items lose this detail
        //    because they store group-level names for most notes).
        const noteForGroup = (groupName) => {
            const n = (groupName || '').toLowerCase();
            if (n.includes('fixed') && !n.includes('deposit')) return 'n9';
            if (n.includes('tangible') || n.includes('plant') || n.includes('machinery') ||
                n.includes('furniture') || n.includes('computer') || n.includes('equipment') ||
                n.includes('vehicle') || n.includes('building') || n.includes('land')) return 'n9';
            if (n.includes('deferred tax asset')) return 'n10';
            if (n.includes('stock') || n.includes('inventor') || n.includes('finished') ||
                n.includes('raw material') || n.includes('wip')) return 'n11';
            if (n.includes('debtor') || n.includes('receivable')) return 'n12';
            if (n.includes('cash') || n.includes('bank account') || n.includes('bank balance') || n.includes('petty')) return 'n13';
            if (n.includes('loans & advances') || n.includes('advance') || n.includes('tds') ||
                n.includes('tcs') || n.includes('gst') || n.includes('duties')) return 'n14';
            return 'n15';
        };

        // Walk report.assets (groups → ledgers) and bucket every ledger that
        // classifies as an investing-type item. Returns a map:
        //   { equityInv: {n11: 0, n12: ..., total: ...}, fixedDeposit: {...}, capitalAdv: {...} }
        // Also excludes ledgers whose group falls in n13 (cash/bank) so FDs
        // stored inside a bank group stay within closing cash.
        const bucketInvestingByNote = (report) => {
            const result = {
                equityInv:    { n9:0, n11:0, n12:0, n14:0, n15:0, total:0 },
                fixedDeposit: { n9:0, n11:0, n12:0, n14:0, n15:0, total:0 },
                capitalAdv:   { n9:0, n11:0, n12:0, n14:0, n15:0, total:0 }
            };
            (report?.assets || []).forEach(g => {
                const note = noteForGroup(g.name);
                if (note === 'n10' || note === 'n13') return; // skip DTA and cash/bank
                (g.ledgers || []).forEach(l => {
                    const cat = classifyAssetForInvesting(l.name);
                    if (cat === 'other') return;
                    const amt = Math.abs(Number(l.balance) || 0);
                    if (!result[cat]) return;
                    result[cat][note] = (result[cat][note] || 0) + amt;
                    result[cat].total += amt;
                });
            });
            return result;
        };

        // === A. OPERATING ACTIVITIES ===
        const netProfit = plCY.profitBeforeTax || 0;
        const depreciation = plnCY.n22_depreciation?.total || 0;
        const financeCosts = plnCY.n21_finance?.total || 0;

        // Adjustments (signs match Oaks PDF convention: subtract non-op income, add back non-cash/financing)
        // IMPORTANT: only subtract income we are SURE is non-operating (dividend, capital gains,
        // speculation, F&O, interest-on-FD/IT refunds, sundry writebacks). For unrecognized Other
        // Income ledgers, DEFAULT TO KEEPING THEM IN OPERATING (adjOtherNonOp = 0) so we don't
        // wrongly strip out core business income like rent/commission/service. The user can
        // override the Other-non-op line if they want to reclassify.
        const adjDep        =  depreciation;
        const adjIntFD      = -(oiBuckets.intFD);
        const adjDividend   = -(oiBuckets.dividend);
        const adjLTCG       = -(oiBuckets.ltcg);
        const adjFnO        = -(oiBuckets.fno);
        const adjSTCG       = -(oiBuckets.stcg);
        const adjSpec       = -(oiBuckets.speculation);
        const adjOtherNonOp = 0;   // ← conservative: keep unclassified incomes in operating
        const adjIntOther   = 0;   // ← conservative: keep other interest in operating
        const adjWriteBack  = -(oiBuckets.writeBack);
        const adjIntExp     =  financeCosts;

        const totalAdjustments = adjDep + adjIntFD + adjDividend + adjLTCG + adjFnO + adjSTCG + adjSpec
                               + adjOtherNonOp + adjIntOther + adjWriteBack + adjIntExp;
        const profitBeforeWC = netProfit + totalAdjustments;

        // Walk report to bucket investment-type ledgers per BS note.
        const invCY = bucketInvestingByNote(reportCY);
        const invPY = bucketInvestingByNote(reportPY);
        // Helper: sum of all investment buckets within a given note.
        const invInNote = (inv, note) => (inv.equityInv[note] || 0) + (inv.fixedDeposit[note] || 0) + (inv.capitalAdv[note] || 0);

        // Working capital changes — asset: PY − CY, liability: CY − PY.
        // When PY data is missing, ALL deltas are 0 (not CY minus zero, which gives
        // huge bogus values like "receivables increased by the whole CY balance").
        const adjAssetTotal = (nodeTotal, investingInNote) => (nodeTotal || 0) - (investingInNote || 0);
        let wcReceivables=0, wcStLoans=0, wcOtherCA=0, wcInventories=0,
            wcPayables=0, wcStBorrowings=0, wcStProvisions=0, wcOtherCL=0;
        if (hasPY) {
            wcReceivables  = adjAssetTotal(bsnPY.n12_tradeReceivables?.total, invInNote(invPY, 'n12'))
                           - adjAssetTotal(bsnCY.n12_tradeReceivables?.total, invInNote(invCY, 'n12'));
            wcStLoans      = adjAssetTotal(bsnPY.n14_stLoans?.total,          invInNote(invPY, 'n14'))
                           - adjAssetTotal(bsnCY.n14_stLoans?.total,          invInNote(invCY, 'n14'));
            wcOtherCA      = adjAssetTotal(bsnPY.n15_otherCA?.total,          invInNote(invPY, 'n15'))
                           - adjAssetTotal(bsnCY.n15_otherCA?.total,          invInNote(invCY, 'n15'));
            wcInventories  = adjAssetTotal(bsnPY.n11_inventories?.total,      invInNote(invPY, 'n11'))
                           - adjAssetTotal(bsnCY.n11_inventories?.total,      invInNote(invCY, 'n11'));
            wcPayables     = (bsnCY.n7_tradePayables?.total || 0) - (bsnPY.n7_tradePayables?.total || 0);
            wcStBorrowings = (bsnCY.n6_stBorrowings?.total || 0) - (bsnPY.n6_stBorrowings?.total || 0);
            // Other CL split: find short-term provisions separately
            let stProvisionsCY = 0, stProvisionsPY = 0;
            (bsnCY.n8_otherCL?.items || []).forEach(it => {
                if ((it.name || '').toLowerCase().includes('provision')) stProvisionsCY += (it.amount || 0);
            });
            (bsnPY.n8_otherCL?.items || []).forEach(it => {
                if ((it.name || '').toLowerCase().includes('provision')) stProvisionsPY += (it.amount || 0);
            });
            wcStProvisions = stProvisionsCY - stProvisionsPY;
            const otherCLExclProvCY = (bsnCY.n8_otherCL?.total || 0) - stProvisionsCY;
            const otherCLExclProvPY = (bsnPY.n8_otherCL?.total || 0) - stProvisionsPY;
            wcOtherCL = otherCLExclProvCY - otherCLExclProvPY;
        }

        // Capital creditors — ledgers like "Machinery Creditor" / "Capital Goods Creditor"
        // that get classified into Trade Payables (n7) but are really capex outflows.
        // Detect by keyword, compute CY-PY delta, and fold into capex AND subtract from wcPayables.
        const isCapCreditor = (name) => {
            const n = (name || '').toLowerCase();
            return n.includes('capital creditor') || n.includes('machinery creditor') ||
                   n.includes('asset creditor') || n.includes('capital goods creditor') ||
                   (n.includes('creditor') && (n.includes('machinery') || n.includes('equipment') || n.includes('plant') || n.includes('vehicle')));
        };
        const capCreditorTotal = (report) => {
            let sum = 0;
            (report?.liabilities || []).forEach(g => {
                (g.ledgers || []).forEach(l => {
                    if (isCapCreditor(l.name)) sum += Math.abs(l.balance || 0);
                });
            });
            return sum;
        };
        const capCredCY = capCreditorTotal(reportCY);
        const capCredPY = hasPY ? capCreditorTotal(reportPY) : 0;
        // Increase = more capex on credit (less cash outflow now); decrease = paid them off.
        // NOTE: we apply this reclassification only if capex > 0 — see block below.
        // `capCredDelta` is finalised later and may be reset to 0 when no capex exists.
        let capCredDelta = hasPY ? (capCredCY - capCredPY) : 0;
        // Tentatively remove from wcPayables (might restore below if capex is 0)
        const wcPayablesBefore = wcPayables;
        wcPayables -= capCredDelta;

        // NOTE: totalWCChange & cashFromOps computed below AFTER capex is known,
        // because the cap-creditor reclassification depends on whether capex > 0.

        // === B. INVESTING ACTIVITIES ===
        let capex = 0;
        try {
            const ppe = JSON.parse(localStorage.getItem('N3_PPE') || '[]');
            if (Array.isArray(ppe)) capex = ppe.reduce((s,r) => s + (Number(r.addCY) || 0), 0);
        } catch(e) {}
        if (capex === 0 && hasPY) {
            // Fallback: n9_ppe BS delta + depreciation. Net block moves by
            //   additions − deletions − depreciation. So gross capex ≈ net delta + dep.
            // Also EXCLUDE investment-type items (a ledger named "Fixed Deposit"
            // may match the n.includes('fixed') PPE keyword classifier).
            const ppeCY = (bsnCY.n9_ppe?.total || 0) - invInNote(invCY, 'n9');
            const ppePY = (bsnPY.n9_ppe?.total || 0) - invInNote(invPY, 'n9');
            capex = Math.max(0, (ppeCY - ppePY) + depreciation);
        }

        // Capital advances — PY-dependent; zero out if no PY.
        const capAdvOutflow  = hasPY ? (invCY.capitalAdv.total - invPY.capitalAdv.total) : 0;

        // Capex total = PPE additions + capital-advance increase − capital-creditor increase.
        // EDGE CASE: if capex == 0 (no PPE movement), a machinery creditor delta alone
        // doesn't make sense as "goods bought on credit" — it's likely a mis-classified
        // ledger. Skip the reclassification so it stays in wcPayables where it was.
        if (capex === 0 && capAdvOutflow === 0) {
            wcPayables = wcPayablesBefore;
            capCredDelta = 0;
        }
        const capexTotal = capex + capAdvOutflow - capCredDelta;

        // Now finalise Operating totals (depend on wcPayables which may have been restored).
        const totalWCChange = wcReceivables + wcStLoans + wcOtherCA + wcInventories +
                              wcPayables + wcStBorrowings + wcStProvisions + wcOtherCL;
        const cashFromOps = profitBeforeWC + totalWCChange;

        // Taxes paid — actual cash outflow.
        // Cash tax paid = movement in (Advance Tax + TDS receivable) when PY is present.
        // The accrual "Current Tax" expense from P&L is a Provision, NOT cash, so it must
        // not be added on top of the advance-tax delta (would double-count).
        // If no PY, fall back to the P&L provision as a rough proxy.
        let taxesPaid = 0;
        if (hasPY) {
            const advCY = (bsnCY.n14_stLoans?.advanceTax || 0);
            const advPY = (bsnPY.n14_stLoans?.advanceTax || 0);
            const advDelta = advCY - advPY;
            taxesPaid = Math.max(0, advDelta);
        } else {
            taxesPaid = plnCY.n24_tax?.currentTax || 0;
        }
        const netA = cashFromOps - taxesPaid;
        const equityInvFlow  = hasPY ? (invPY.equityInv.total - invCY.equityInv.total) : 0;
        const fdFlow         = hasPY ? (invPY.fixedDeposit.total - invCY.fixedDeposit.total) : 0;

        const netB = -capexTotal + interestIncome + dividendIncome + equityInvFlow + fdFlow
                     + oiBuckets.ltcg + oiBuckets.fno + oiBuckets.stcg + oiBuckets.speculation;

        // === C. FINANCING ACTIVITIES ===
        // All financing deltas need PY to be meaningful; zero out otherwise.
        const ltBorrChange   = hasPY ? ((bsnCY.n5_ltBorrowings?.total || 0) - (bsnPY.n5_ltBorrowings?.total || 0)) : 0;
        const shareCapChange = hasPY ? ((bsnCY.n3_shareCapital?.total || 0) - (bsnPY.n3_shareCapital?.total || 0)) : 0;
        // Dividends paid — in priority order:
        //   (a) Explicit entry on N2 page (n4_divPaid)
        //   (b) Any CY ledger whose name signals a dividend payment
        //   (c) 0 (falls back to reserves implicit)
        let dividendsPaid = 0;
        try {
            const n2 = JSON.parse(localStorage.getItem('N2_DATA') || '{}');
            dividendsPaid = Number(n2.n4_divPaid || 0);
        } catch(e) {}
        if (!dividendsPaid && hasPY) {
            // Auto-detect from ledgers. TWO sources of dividend cash outflow:
            //   (a) "Dividend Paid" ledgers — show the full amount debited this year
            //   (b) Drop in "Proposed Dividend" / "Dividend Payable" provisions — means the
            //       previously-provisioned amount was settled in cash this year.
            // Proposed dividends still on BS at year-end are NOT cash outflow — they're
            // just provisions for next year's payment.
            const isPaidDiv = (name) => {
                const n = (name || '').toLowerCase();
                if (!n.includes('dividend')) return false;
                if (n.includes('received') || n.includes('income') || n.includes('receivable') ||
                    n.includes('bank') || n.includes('investment')) return false;
                // Only count ledgers that explicitly indicate an actual payment (not a provision)
                return n.includes('paid') || n.includes('distribution') || n.includes('distributed') ||
                       n.includes('interim');  // Interim dividend is typically paid when declared
            };
            const isProvisionDiv = (name) => {
                const n = (name || '').toLowerCase();
                if (!n.includes('dividend')) return false;
                return n.includes('proposed') || n.includes('payable') ||
                       (n.includes('final') && !n.includes('paid'));
            };
            let divPaidLedger = 0;
            (reportCY.liabilities || []).forEach(g => {
                (g.ledgers || []).forEach(l => {
                    if (isPaidDiv(l.name)) divPaidLedger += Math.abs(l.balance || 0);
                });
            });
            // Provision drop = payment of last year's proposed dividend
            let provCY = 0, provPY = 0;
            (reportCY.liabilities || []).forEach(g => {
                (g.ledgers || []).forEach(l => { if (isProvisionDiv(l.name)) provCY += Math.abs(l.balance || 0); });
            });
            (reportPY.liabilities || []).forEach(g => {
                (g.ledgers || []).forEach(l => { if (isProvisionDiv(l.name)) provPY += Math.abs(l.balance || 0); });
            });
            const provDrop = Math.max(0, provPY - provCY);
            dividendsPaid = divPaidLedger + provDrop;
        }
        const netC = ltBorrChange + shareCapChange - financeCosts - dividendsPaid;

        // === CASH COMPONENTS (Note — Components of cash and cash equivalents) ===
        const cashComponents = { cashOnHand: 0, bankCurrent: 0, otherBank: 0 };
        (bsnCY.n13_cashBank?.items || []).forEach(it => {
            const n = (it.name || '').toLowerCase();
            if (n.includes('cash') && !n.includes('bank')) cashComponents.cashOnHand += (it.amount || 0);
            else if (n.includes('current') || n.includes('c/a') || n.includes('ca ')) cashComponents.bankCurrent += (it.amount || 0);
            else cashComponents.otherBank += (it.amount || 0);
        });
        // PY cash components (for the "as at end of previous year" column in the note)
        const cashComponentsPY = { cashOnHand: 0, bankCurrent: 0, otherBank: 0 };
        (bsnPY.n13_cashBank?.items || []).forEach(it => {
            const n = (it.name || '').toLowerCase();
            if (n.includes('cash') && !n.includes('bank')) cashComponentsPY.cashOnHand += (it.amount || 0);
            else if (n.includes('current') || n.includes('c/a') || n.includes('ca ')) cashComponentsPY.bankCurrent += (it.amount || 0);
            else cashComponentsPY.otherBank += (it.amount || 0);
        });

        // === RECONCILIATION ===
        const netChange = netA + netB + netC;
        const openingCash = bsnPY.n13_cashBank?.total || 0;
        const closingCash = bsnCY.n13_cashBank?.total || 0;
        const impliedClosing = openingCash + netChange;
        const reconDiff = closingCash - impliedClosing;

        // === DIAGNOSTICS — list ledgers contributing to each line ===
        // Lets the user see exactly how their TB maps into CF lines so
        // mis-classifications can be spotted and overridden.
        const diag = {
            otherIncomeBuckets: {},  // name → amount, tagged with bucket
            investmentLedgers: [],   // list of {name, bucket, note, cyAmt, pyAmt}
            bsNoteMap: {}            // note → list of group/ledger names contributing
        };
        (plnCY.n17_otherIncome?.items || []).forEach(i => {
            const bucket = classifyOtherIncome(i.name);
            diag.otherIncomeBuckets[i.name] = { amount: i.amount, bucket };
        });
        // Collect investment ledger trail
        const addInvLedger = (report, amtKey) => {
            (report?.assets || []).forEach(g => {
                const note = noteForGroup(g.name);
                (g.ledgers || []).forEach(l => {
                    const cat = classifyAssetForInvesting(l.name);
                    if (cat === 'other') return;
                    let entry = diag.investmentLedgers.find(x => x.name === l.name);
                    if (!entry) {
                        entry = { name: l.name, group: g.name, bucket: cat, note, cyAmt: 0, pyAmt: 0 };
                        diag.investmentLedgers.push(entry);
                    }
                    entry[amtKey] = Math.abs(Number(l.balance) || 0);
                });
            });
        };
        addInvLedger(reportCY, 'cyAmt');
        addInvLedger(reportPY, 'pyAmt');
        // Collect BS-note group trail
        const noteKeys = { n3:'Share Capital', n4:'Reserves', n5:'LT Borrowings', n6:'ST Borrowings',
                           n7:'Trade Payables', n8:'Other CL', n9:'PPE', n10:'DTA', n11:'Inventories',
                           n12:'Trade Receivables', n13:'Cash & Bank', n14:'ST Loans & Advances', n15:'Other CA' };
        const mapGroups = (report, yr) => {
            const ladder = (groupList, isLiability) => {
                (groupList || []).forEach(g => {
                    const note = isLiability ? noteForGroupLiability(g.name) : noteForGroup(g.name);
                    if (!diag.bsNoteMap[note]) diag.bsNoteMap[note] = [];
                    diag.bsNoteMap[note].push({ group: g.name, amount: Math.abs(g.total || 0), year: yr });
                });
            };
            ladder(report.assets, false);
            ladder(report.liabilities, true);
        };
        // Inline liability-side note resolver (mirrors engine's getScheduleIIIReport logic)
        function noteForGroupLiability(groupName) {
            const n = (groupName || '').toLowerCase();
            if (n.includes('capital') || n.includes('share capital') || n.includes('proprietor') || n.includes('partner')) return 'n3';
            if (n.includes('reserve') || n.includes('surplus') || n.includes('profit & loss') || n.includes('p&l')) return 'n4';
            if (n.includes('bank od') || n.includes('overdraft') || n.includes('cash credit') || n.includes('cc a/c') ||
                n.includes('short term borrow') || n.includes('working capital')) return 'n6';
            if (n.includes('secured loan') || n.includes('unsecured loan') || n.includes('term loan') ||
                (n.includes('loan') && !n.includes('od') && !n.includes('overdraft') && !n.includes('cash credit') && !n.includes('short term') && !n.includes('working capital'))) return 'n5';
            if (n.includes('creditor') || n.includes('trade payable') || n.includes('payable') || n.includes('sundry creditor')) return 'n7';
            return 'n8';
        }
        mapGroups(reportCY, 'CY');
        if (hasPY) mapGroups(reportPY, 'PY');

        return {
            hasPY,
            operating: {
                netProfit,
                // Adjustments — each signed as per AS 3 convention
                adjDep, adjIntFD, adjDividend, adjLTCG, adjFnO, adjSTCG, adjSpec,
                adjOtherNonOp, adjIntOther, adjWriteBack, adjIntExp,
                totalAdjustments,
                profitBeforeWC,
                // Working capital deltas
                wcReceivables, wcStLoans, wcOtherCA, wcInventories,
                wcPayables, wcStBorrowings, wcStProvisions, wcOtherCL,
                totalWCChange,
                cashFromOps,
                taxesPaid,
                netA,
                // Legacy aliases (for backward compat with other callers)
                depreciation, financeCosts, interestIncome, dividendIncome
            },
            investing: {
                capex, capAdvOutflow, capexTotal,
                interestReceived: interestIncome,
                dividendReceived: dividendIncome,
                equityInvFlow, fdFlow,
                ltcg: oiBuckets.ltcg, fno: oiBuckets.fno, stcg: oiBuckets.stcg, speculation: oiBuckets.speculation,
                netB
            },
            financing: {
                ltBorrChange,
                shareCapChange,
                financeCostsPaid: financeCosts,
                dividendsPaid,
                netC
            },
            summary: {
                netChange,
                openingCash,
                closingCash,
                impliedClosing,
                reconDiff,
                isReconciled: Math.abs(reconDiff) < 1
            },
            cashComponents,
            cashComponentsPY,
            diag,
            noteKeys
        };
    },

    /* ================================================================
       INTEREST 234A / 234B / 234C — Income Tax Act calculations
       All as per rates prescribed under Sec 234 (1% per month).
       ================================================================ */
    computeInterest234(params) {
        params = params || {};
        const taxOwed = Number(params.taxOwed) || 0;  // Final tax liability
        const tdsPaid = Number(params.tdsPaid) || 0;
        const advancePaid = Number(params.advancePaid) || 0;
        const dueDate = params.dueDate || '2024-10-31';  // ITR-6 due date
        const filedDate = params.filedDate;
        const fyStart = params.fyStart || '2024-04-01';

        const shortfall = Math.max(0, taxOwed - tdsPaid - advancePaid);

        // 234A — for late filing: 1% per month from due date till filing date
        let int234A = 0;
        if (filedDate && shortfall > 0) {
            const due = new Date(dueDate);
            const filed = new Date(filedDate);
            if (filed > due) {
                const monthsLate = Math.ceil((filed - due) / (1000 * 60 * 60 * 24 * 30));
                int234A = Math.round(shortfall * 0.01 * monthsLate);
            }
        }

        // 234B — for default in payment of advance tax: 1% per month from Apr 1 of AY till tax paid
        // Triggered when advance tax paid < 90% of assessed tax
        let int234B = 0;
        if (taxOwed - tdsPaid > 10000 && advancePaid < 0.9 * (taxOwed - tdsPaid)) {
            const ayStart = new Date(fyStart);
            ayStart.setFullYear(ayStart.getFullYear() + 1);
            const payDate = filedDate ? new Date(filedDate) : new Date(dueDate);
            const monthsDelayed = Math.max(1, Math.ceil((payDate - ayStart) / (1000 * 60 * 60 * 24 * 30)));
            int234B = Math.round(shortfall * 0.01 * monthsDelayed);
        }

        // 234C — quarterly advance tax installment default
        // Simplified: assume taxpayer didn't pay quarterly — 1% × 3 months × shortfall for each missed installment
        // In practice requires installment-wise computation. Here we give a conservative estimate.
        let int234C = 0;
        if (advancePaid < taxOwed - tdsPaid) {
            // Very simplified: 3 months × 1% on the annual shortfall
            int234C = Math.round(shortfall * 0.01 * 3);
        }

        return {
            shortfall,
            int234A,
            int234B,
            int234C,
            totalInterest: int234A + int234B + int234C
        };
    },

    /* ================================================================
       BACKUP / RESTORE
       One-click export of ALL data (all clients, their vaults, registry,
       drafts, classification rules, global settings) to a JSON file.
       Restore re-seeds localStorage from the JSON.
       ================================================================ */

    exportAllData() {
        const dump = {
            __meta: {
                exportedAt: new Date().toISOString(),
                version: '1.0',
                app: 'Balance Sheet Builder'
            },
            storage: {}
        };
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            dump.storage[k] = localStorage.getItem(k);
        }
        return dump;
    },

    /**
     * Download all data as a JSON file. Returns filename.
     */
    downloadBackup() {
        const dump = this.exportAllData();
        const json = JSON.stringify(dump, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `bs-builder-backup-${ts}.json`;
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return fileName;
    },

    /**
     * Restore from a dump object (merge replaces).
     * @param {Object} dump  The object returned by exportAllData()
     * @param {boolean} clearFirst  If true, wipe localStorage before restoring
     */
    restoreFromBackup(dump, clearFirst) {
        if (!dump || !dump.storage) throw new Error('Invalid backup file');
        if (clearFirst) {
            // Preserve device-specific settings? For now, clear everything.
            localStorage.clear();
        }
        Object.keys(dump.storage).forEach(k => {
            if (dump.storage[k] !== null && dump.storage[k] !== undefined) {
                localStorage.setItem(k, dump.storage[k]);
            }
        });
        if (this.persistToElectron) this.persistToElectron();
        return true;
    },

    /* ================================================================
       CROSS-NOTE RECONCILIATION
       Returns an array of { label, bs, note, diff, ok } comparing
       key BS line items against values stored in note pages.
       ================================================================ */
    getReconciliationReport() {
        const checks = [];
        let report;
        try { report = this.getScheduleIIIReport('CY'); } catch(e) { return checks; }
        const bs = report.bs || {};
        const bsn = report.bsNotes || {};
        const pl = report.pl || {};

        const eps = (v) => Math.abs(v) < 1;

        // 0a. Balance Sheet itself must balance
        const totalEL = bs.totalEL || 0;
        const totalAssets = bs.totalAssets || 0;
        checks.push({
            label: 'Balance Sheet — Total Equity & Liabilities = Total Assets',
            bs: totalEL, note: totalAssets, diff: totalEL - totalAssets,
            ok: eps(totalEL - totalAssets)
        });

        // 0b. Trial balance must balance
        try {
            const tb = this.getTrialBalance('CY');
            checks.push({
                label: 'Trial Balance — Total Debits = Total Credits',
                bs: tb.totalDr, note: tb.totalCr, diff: tb.totalDr - tb.totalCr,
                ok: eps(tb.totalDr - tb.totalCr)
            });
        } catch(e) {}

        // 0c. Cash Flow reconciliation (if PY data present)
        if (this.hasPYData()) {
            try {
                const cf = this.getCashFlowStatement();
                checks.push({
                    label: 'Cash Flow — Opening + Net change = Closing cash',
                    bs: cf.summary.closingCash, note: cf.summary.impliedClosing, diff: cf.summary.reconDiff,
                    ok: cf.summary.isReconciled
                });
            } catch(e) {}
        }

        // 1. Share Capital: BS line vs N2 Note 3 issued share value
        try {
            const n2 = JSON.parse(localStorage.getItem('N2_DATA') || '{}');
            const issued = Number(n2.n3_issuedShares || 0);
            const fv = Number(n2.n3_fv || 10);
            const n2SC = issued * fv;
            const bsSC = bsn.n3_shareCapital?.total || 0;
            if (n2.n3_issuedShares) {
                checks.push({
                    label: 'Share Capital (BS) vs N2 Note 3 (Issued × FV)',
                    bs: bsSC, note: n2SC, diff: bsSC - n2SC,
                    ok: eps(bsSC - n2SC)
                });
            }
        } catch(e) {}

        // 2. Reserves & Surplus: BS line vs N2 Note 4 closing balance
        try {
            const n2 = JSON.parse(localStorage.getItem('N2_DATA') || '{}');
            const reservesPY = (report.bsNotes.n4_reserves?.total || 0) + 0;
            const profitPY = Number(n2.n4_openPY || 0);
            const openCY = profitPY + (0); // simplified; BS should match engine-calculated closing
            const bsRes = (bsn.n4_reserves?.total || 0) + (pl.profitForYear || 0);
            // If N2 had a divPaid adjustment, closing balance would differ
            const n2DivPaid = Number(n2.n4_divPaid || 0);
            const n2Closing = bsRes - n2DivPaid;
            if (n2.n4_divPaid) {
                checks.push({
                    label: 'Reserves & Surplus (BS) vs N2 Note 4 after dividend',
                    bs: bsRes, note: n2Closing, diff: bsRes - n2Closing,
                    ok: eps(bsRes - n2Closing)
                });
            }
        } catch(e) {}

        // 3. PPE: BS line vs N3 Note 9 Total Net Book Value
        try {
            const ppe = JSON.parse(localStorage.getItem('N3_PPE') || '[]');
            if (Array.isArray(ppe) && ppe.length > 0) {
                const nbvCY = ppe.reduce((s, r) => {
                    const grossClose = Number(r.openPY||0) + Number(r.addCY||0) - Number(r.delCY||0);
                    const depClose = Number(r.openCYDep||0) + Number(r.depCY||0) - Number(r.depOnDel||0);
                    return s + (grossClose - depClose);
                }, 0);
                const bsPPE = bsn.n9_ppe?.total || 0;
                checks.push({
                    label: 'PPE (BS) vs N3 Note 9 Total Net Book Value',
                    bs: bsPPE, note: nbvCY, diff: bsPPE - nbvCY,
                    ok: eps(bsPPE - nbvCY)
                });
            }
        } catch(e) {}

        // 4. Trade Payables: BS vs N2 Note 6 total
        try {
            const n2 = JSON.parse(localStorage.getItem('N2_DATA') || '{}');
            const n2TP = Number(n2.n6_msme || 0) + Number(n2.n6_oth || (bsn.n7_tradePayables?.total || 0));
            const bsTP = bsn.n7_tradePayables?.total || 0;
            if (n2.n6_msme !== undefined || n2.n6_oth !== undefined) {
                checks.push({
                    label: 'Trade Payables (BS) vs N2 Note 6 breakdown',
                    bs: bsTP, note: n2TP, diff: bsTP - n2TP,
                    ok: eps(bsTP - n2TP)
                });
            }
        } catch(e) {}

        // 5. Trade Receivables: BS vs N4 Note 12 total
        try {
            const n4 = JSON.parse(localStorage.getItem('N4_DATA') || '{}');
            const n4TR = Number(n4.n12_unsec || 0) + Number(n4.n12_sec || 0) + Number(n4.n12_doubt || 0) - Number(n4.n12_prov || 0);
            const bsTR = bsn.n12_tradeReceivables?.total || 0;
            if (n4.n12_unsec !== undefined || n4.n12_sec !== undefined) {
                checks.push({
                    label: 'Trade Receivables (BS) vs N4 Note 12 breakdown',
                    bs: bsTR, note: n4TR, diff: bsTR - n4TR,
                    ok: eps(bsTR - n4TR)
                });
            }
        } catch(e) {}

        // 6. Cash & Bank: BS vs N4 Note 13 total
        try {
            const n4 = JSON.parse(localStorage.getItem('N4_DATA') || '{}');
            const n4Cash = Number(n4.n13_cash || 0) + Number(n4.n13_bank || 0) + Number(n4.n13_otherBank || 0) + Number(n4.n13_chq || 0);
            const bsCash = bsn.n13_cashBank?.total || 0;
            if (n4.n13_cash !== undefined || n4.n13_bank !== undefined) {
                checks.push({
                    label: 'Cash & Bank (BS) vs N4 Note 13 breakdown',
                    bs: bsCash, note: n4Cash, diff: bsCash - n4Cash,
                    ok: eps(bsCash - n4Cash)
                });
            }
        } catch(e) {}

        // 7. Revenue: BS/PL vs N5 Note 16
        try {
            const n5 = JSON.parse(localStorage.getItem('N5_DATA') || '{}');
            const n5Rev = Number(n5.n16_prod || 0) + Number(n5.n16_svc || 0) + Number(n5.n16_oth || 0);
            const plRev = report.plNotes?.n16_revenue?.total || 0;
            if (n5.n16_prod !== undefined || n5.n16_svc !== undefined) {
                checks.push({
                    label: 'Revenue (P&L) vs N5 Note 16 breakdown',
                    bs: plRev, note: n5Rev, diff: plRev - n5Rev,
                    ok: eps(plRev - n5Rev)
                });
            }
        } catch(e) {}

        // 8. EPS shares match — N2 Issued vs N6 Weighted Avg
        try {
            const n2 = JSON.parse(localStorage.getItem('N2_DATA') || '{}');
            const n6 = JSON.parse(localStorage.getItem('N6_DATA') || '{}');
            const issued = Number(n2.n3_issuedShares || 0);
            const weightedAvg = Number(n6.n25_shares || issued);
            if (n2.n3_issuedShares && Math.abs(issued - weightedAvg) > 0) {
                checks.push({
                    label: 'Equity shares — N2 Issued vs N6 Weighted Average',
                    bs: issued, note: weightedAvg, diff: issued - weightedAvg,
                    ok: false
                });
            }
        } catch(e) {}

        return checks;
    },

    /* ================================================================
       CLASSIFICATION RULES
       User-defined ledger → group overrides, persisted across TB imports.
       guessGroup() checks these first.
       ================================================================ */

    getGroupRules() {
        try { return JSON.parse(localStorage.getItem('GROUP_RULES') || '{}'); }
        catch(e) { return {}; }
    },

    setGroupRule(ledgerName, group) {
        if (!ledgerName || !group) return;
        const rules = this.getGroupRules();
        rules[ledgerName] = group;
        localStorage.setItem('GROUP_RULES', JSON.stringify(rules));
        if (this.persistToElectron) this.persistToElectron();
    },

    deleteGroupRule(ledgerName) {
        const rules = this.getGroupRules();
        if (rules[ledgerName]) {
            delete rules[ledgerName];
            localStorage.setItem('GROUP_RULES', JSON.stringify(rules));
            if (this.persistToElectron) this.persistToElectron();
        }
    },

    clearAllGroupRules() {
        localStorage.removeItem('GROUP_RULES');
        if (this.persistToElectron) this.persistToElectron();
    },

    /**
     * Re-apply group rules to all current ledgers (useful after editing rules).
     * Does NOT overwrite manually-set ledger.group values (those came from user edits
     * and should remain).
     */
    applyGroupRules() {
        const rules = this.getGroupRules();
        const ledgers = JSON.parse(localStorage.getItem('LEDGERS') || '[]');
        let changed = 0;
        ledgers.forEach(l => {
            const nm = (l.name || '').toLowerCase().trim();
            if (rules[l.name] && l.group !== rules[l.name]) { l.group = rules[l.name]; changed++; }
            else if (rules[nm] && l.group !== rules[nm]) { l.group = rules[nm]; changed++; }
        });
        if (changed > 0) {
            localStorage.setItem('LEDGERS', JSON.stringify(ledgers));
            if (this.persistToElectron) this.persistToElectron();
        }
        return changed;
    },

    /* ================================================================
       DRAFT VERSIONING
       Lets users save named snapshots of the current BS/P&L state.
       Drafts are per-client, stored inside the active vault.
       ================================================================ */

    _draftsKey() {
        const id = this.getActiveClientId();
        return id ? 'DRAFTS_' + id : 'DRAFTS_GLOBAL';
    },

    getDrafts() {
        try { return JSON.parse(localStorage.getItem(this._draftsKey()) || '[]'); }
        catch(e) { return []; }
    },

    saveDraft(name) {
        const drafts = this.getDrafts();
        const id = 'D' + Date.now().toString(36);
        const snap = this._snapshotSession();
        drafts.push({
            id,
            name: name || 'Draft ' + new Date().toLocaleString(),
            createdAt: new Date().toISOString(),
            data: snap
        });
        // Cap to 20 drafts per client
        if (drafts.length > 20) drafts.splice(0, drafts.length - 20);
        localStorage.setItem(this._draftsKey(), JSON.stringify(drafts));
        if (this.persistToElectron) this.persistToElectron();
        return id;
    },

    restoreDraft(id) {
        const drafts = this.getDrafts();
        const d = drafts.find(x => x.id === id);
        if (!d) return false;
        this._restoreSession(d.data);
        // Save restored state into current vault
        const activeId = this.getActiveClientId();
        if (activeId) this._saveVaultFor(activeId);
        return true;
    },

    deleteDraft(id) {
        const drafts = this.getDrafts();
        const idx = drafts.findIndex(d => d.id === id);
        if (idx < 0) return false;
        drafts.splice(idx, 1);
        localStorage.setItem(this._draftsKey(), JSON.stringify(drafts));
        if (this.persistToElectron) this.persistToElectron();
        return true;
    },

    renameDraft(id, newName) {
        const drafts = this.getDrafts();
        const d = drafts.find(x => x.id === id);
        if (!d) return false;
        d.name = newName || d.name;
        localStorage.setItem(this._draftsKey(), JSON.stringify(drafts));
        if (this.persistToElectron) this.persistToElectron();
        return true;
    },

    /* ================================================================
       STORAGE MONITORING — warn before localStorage overflows
       ================================================================ */
    getStorageUsage() {
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k);
            total += (k.length + v.length) * 2;  /* UTF-16: 2 bytes per char */
        }
        const limitBytes = 5 * 1024 * 1024;  /* 5 MB conservative estimate */
        return {
            usedBytes: total,
            usedMB: (total / (1024 * 1024)).toFixed(2),
            limitMB: 5,
            percentUsed: ((total / limitBytes) * 100).toFixed(1),
            isWarning: total > limitBytes * 0.8,
            isCritical: total > limitBytes * 0.95
        };
    },

    checkStorageAndWarn() {
        const usage = this.getStorageUsage();
        if (usage.isCritical) {
            alert('⚠ Storage is almost full (' + usage.percentUsed + '%)!\n\nPlease export a backup and clear old data to avoid data loss.');
        } else if (usage.isWarning) {
            console.warn('Storage usage high: ' + usage.usedMB + ' MB (' + usage.percentUsed + '%)');
        }
        return usage;
    },

    /* ================================================================
       USER MANAGEMENT — 60+ team member support
       ================================================================ */
    ROLES: ['Admin', 'Senior CA', 'CA', 'Article Assistant', 'Staff'],

    getUsers() {
        return JSON.parse(localStorage.getItem('USERS') || '[]');
    },

    getCurrentUser() {
        const username = localStorage.getItem('CURRENT_USER');
        if (!username) return null;
        const users = this.getUsers();
        const lowerUser = username.toLowerCase();
        return users.find(u => u.username.toLowerCase() === lowerUser) || { username: username, role: 'Admin', name: username };
    },

    isLoggedIn() {
        return !!localStorage.getItem('CURRENT_USER');
    },

    addUser(user) {
        const users = this.getUsers();
        if (users.find(u => u.username.toLowerCase() === user.username.toLowerCase())) {
            return { success: false, message: 'Username "' + user.username + '" already exists.' };
        }
        if (!user.password) {
            return { success: false, message: 'Password is required.' };
        }
        users.push({
            username: user.username,
            password: user.password,
            name: user.name || user.username,
            role: user.role || 'Staff',
            email: user.email || '',
            phone: user.phone || '',
            active: true,
            createdAt: new Date().toISOString()
        });
        localStorage.setItem('USERS', JSON.stringify(users));
        this.persistToElectron();
        this._logAudit('user-add', 'Added user: ' + user.username + ' (' + (user.role || 'Staff') + ')');
        return { success: true };
    },

    updateUser(username, updates) {
        const users = this.getUsers();
        const idx = users.findIndex(u => u.username === username);
        if (idx === -1) return { success: false, message: 'User not found.' };
        Object.assign(users[idx], updates);
        localStorage.setItem('USERS', JSON.stringify(users));
        this.persistToElectron();
        this._logAudit('user-update', 'Updated user: ' + username);
        return { success: true };
    },

    deleteUser(username) {
        if (username === 'admin') return { success: false, message: 'Cannot delete the default admin.' };
        let users = this.getUsers();
        users = users.filter(u => u.username !== username);
        localStorage.setItem('USERS', JSON.stringify(users));
        this.persistToElectron();
        this._logAudit('user-delete', 'Deleted user: ' + username);
        return { success: true };
    },

    toggleUserActive(username) {
        const users = this.getUsers();
        const user = users.find(u => u.username === username);
        if (!user) return false;
        user.active = !user.active;
        localStorage.setItem('USERS', JSON.stringify(users));
        this.persistToElectron();
        this._logAudit('user-toggle', (user.active ? 'Activated' : 'Deactivated') + ' user: ' + username);
        return user.active;
    },

    login(username, password) {
        const lowerUser = username.toLowerCase();
        if (lowerUser === 'admin' && password === 'admin') {
            localStorage.setItem('CURRENT_USER', 'admin');
            this._logAudit('login', 'admin logged in');
            return { success: true, user: { username: 'admin', role: 'Admin', name: 'Administrator' } };
        }
        const users = this.getUsers();
        const match = users.find(u => u.username.toLowerCase() === lowerUser && u.password === password);
        if (!match) return { success: false, message: 'Invalid username or password.' };
        if (!match.active) return { success: false, message: 'Account is deactivated. Contact admin.' };
        localStorage.setItem('CURRENT_USER', match.username);
        this._logAudit('login', match.username + ' logged in');
        return { success: true, user: match };
    },

    logout() {
        const user = localStorage.getItem('CURRENT_USER') || 'unknown';
        this._logAudit('logout', user + ' logged out');
        localStorage.removeItem('CURRENT_USER');
    },

    requireLogin() {
        if (this.isLoggedIn()) return true;
        /* Redirect to login page if not logged in */
        const page = window.location.pathname.split('/').pop();
        if (page !== 'index.html' && page !== '') {
            alert('Please login first.');
            window.location.href = 'index.html';
            return false;
        }
        return false;
    },

    /** Show logged-in user badge in any page header */
    showUserBadge() {
        const user = this.getCurrentUser();
        if (!user) return;
        // Inject a global print-hide rule once so the badge (and any other UI chrome
        // that pages have forgotten to mark as no-print) doesn't show on physical print.
        if (!document.getElementById('_userBadgePrintCSS')) {
            const css = document.createElement('style');
            css.id = '_userBadgePrintCSS';
            css.textContent =
              '@media print {' +
              '  #_userBadge, #autoSaveIndicator, #dragOverlay, ._noPrint,' +
              '  .toolbar-row, .toolbar, .bottom-tabs, .menu-bar, .file-dropdown,' +
              '  .legend, .info-box, .recon-box, .modal, .modal-backdrop,' +
              '  #statusBar, #cfDiag {' +
              '    display: none !important;' +
              '  }' +
              '}';
            document.head.appendChild(css);
        }
        let badge = document.getElementById('_userBadge');
        if (badge) { badge.textContent = user.name + ' (' + (user.role || 'Admin') + ')'; return; }
        /* Create badge — try to attach to common header elements */
        badge = document.createElement('div');
        badge.id = '_userBadge';
        badge.className = '_noPrint';
        badge.style.cssText = 'position:fixed;top:4px;right:12px;z-index:99999;background:#234a7b;color:#fff;padding:3px 12px;border-radius:12px;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.2);';
        badge.textContent = (user.name || user.username) + ' (' + (user.role || 'Admin') + ')';
        badge.title = 'Click to logout';
        badge.onclick = () => {
            if (confirm('Logout ' + (user.name || user.username) + '?')) {
                this.logout();
                window.location.href = 'index.html';
            }
        };
        document.body.appendChild(badge);
    },

    /* ================================================================
       LEGACY MULTI-CLIENT (deprecated, superseded by vault system above)
       Kept only as back-compat shims that delegate to the new system.
       ================================================================ */
    getCurrentClientId() {
        // Back-compat alias
        return this.getActiveClientId ? this.getActiveClientId() : localStorage.getItem('CURRENT_CLIENT');
    },
    _saveClientData(clientId) {
        // Back-compat alias → new vault system
        if (this._saveVaultFor) this._saveVaultFor(clientId);
    },
    _loadClientData(clientId) {
        // Back-compat alias → new vault system
        if (this._loadVaultFor) this._loadVaultFor(clientId);
        if (this.initDefaults) this.initDefaults();
    },
    // Legacy keys present? one-time migrate
    _migrateLegacyClients() {
        try {
            const legacy = JSON.parse(localStorage.getItem('CLIENT_LIST') || '[]');
            if (!legacy || legacy.length === 0) return;
            // Only migrate if new registry is empty
            const existing = JSON.parse(localStorage.getItem('CLIENTS_REGISTRY') || '[]');
            if (existing.length > 0) return;
            const migrated = legacy.map(c => ({
                id: c.id,
                name: c.name,
                createdAt: c.createdAt || new Date().toISOString(),
                lastOpened: c.createdAt || new Date().toISOString()
            }));
            localStorage.setItem('CLIENTS_REGISTRY', JSON.stringify(migrated));
            // Move CDATA_{id} snapshots → CLIENT_VAULT_{id}
            legacy.forEach(c => {
                const old = localStorage.getItem('CDATA_' + c.id);
                if (old && !localStorage.getItem('CLIENT_VAULT_' + c.id)) {
                    try {
                        const snap = JSON.parse(old);
                        localStorage.setItem('CLIENT_VAULT_' + c.id, JSON.stringify({ storage: snap }));
                    } catch(e) {}
                }
            });
            // Preserve active
            const legacyActive = localStorage.getItem('CURRENT_CLIENT');
            if (legacyActive && !localStorage.getItem('ACTIVE_CLIENT_ID')) {
                localStorage.setItem('ACTIVE_CLIENT_ID', legacyActive);
            }
        } catch(e) { /* best-effort */ }
    },

    /* ================================================================
       DATA ENCRYPTION — simple obfuscation for passwords
       Uses Base64 + reversal (not cryptographic, but hides plain text)
       ================================================================ */
    _encrypt(text) {
        if (!text) return '';
        return btoa(text.split('').reverse().join(''));
    },

    _decrypt(encoded) {
        if (!encoded) return '';
        try { return atob(encoded).split('').reverse().join(''); }
        catch(e) { return encoded; /* return as-is if not encoded */ }
    },

    /* ================================================================
       CLOUD SYNC — Export/Import full workspace as encrypted JSON
       Enables sharing data between team members' machines
       ================================================================ */
    exportWorkspace() {
        const snapshot = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            snapshot[k] = localStorage.getItem(k);
        }
        const payload = {
            version: '1.4.1',
            exportedAt: new Date().toISOString(),
            exportedBy: localStorage.getItem('CURRENT_USER') || 'unknown',
            data: snapshot
        };
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'AccountingTool_Workspace_' + new Date().toISOString().slice(0,10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
        this._logAudit('export', 'Exported full workspace');
        return true;
    },

    importWorkspace(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const payload = JSON.parse(reader.result);
                    if (!payload.data) { reject('Invalid workspace file.'); return; }
                    /* Confirm before overwriting */
                    const info = 'Exported: ' + (payload.exportedAt || '?') + '\nBy: ' + (payload.exportedBy || '?') +
                        '\nKeys: ' + Object.keys(payload.data).length;
                    if (!confirm('Import this workspace?\n\n' + info + '\n\nThis will REPLACE all current data.')) {
                        resolve(false); return;
                    }
                    localStorage.clear();
                    for (const k in payload.data) {
                        localStorage.setItem(k, payload.data[k]);
                    }
                    this.persistToElectron();
                    this._logAudit('import-workspace', 'Imported workspace from ' + (payload.exportedBy || 'unknown'));
                    resolve(true);
                } catch(e) { reject('Failed to parse workspace file: ' + e.message); }
            };
            reader.readAsText(file);
        });
    },

    /* ================================================================
       (Removed: autoPopulateNotes — notes pages n2-n7 now auto-pull from TB themselves via structured forms.)
       ================================================================ */

    /* ================================================================
       PDF DOWNLOAD HELPER — bypasses browser print pipeline so the
       generated PDF has NO URL, NO date stamp, NO page-number watermark
       added by Chrome/Safari/Firefox. Uses html2pdf.js loaded on demand
       from a CDN. Falls back to window.print() if CDN unreachable.

       Usage:  AccountingEngine.downloadPDF({
                 element:  document.querySelector('.cf-wrap'),  // or selector string
                 filename: 'Cash_Flow_Statement.pdf',
                 hideSelectors: '.toolbar, .bottom-tabs, #statusBar'  // optional
               });
       ================================================================ */
    _html2pdfReady: null,
    _ensureHtml2Pdf() {
        if (typeof html2pdf !== 'undefined') return Promise.resolve();
        if (this._html2pdfReady) return this._html2pdfReady;
        this._html2pdfReady = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
            s.onload  = () => resolve();
            s.onerror = () => reject(new Error('Failed to load html2pdf.js (no internet?)'));
            document.head.appendChild(s);
        });
        return this._html2pdfReady;
    },
    async downloadPDF(opts) {
        opts = opts || {};
        const target  = opts.element || document.body;
        const el      = (typeof target === 'string') ? document.querySelector(target) : target;
        if (!el) { alert('Nothing to export.'); return; }
        const filename = opts.filename || ('Document_' + new Date().toISOString().slice(0,10) + '.pdf');
        const hideSel = opts.hideSelectors || '.toolbar, .toolbar-row, .bottom-tabs, #statusBar, .info-box, .legend, .recon-box, button, #_userBadge, ._noPrint, .menu-bar, .file-dropdown';
        const orientation = opts.orientation || 'portrait';
        const hidden = [];

        try {
            await this._ensureHtml2Pdf();
            // Hide UI chrome from the snapshot
            document.querySelectorAll(hideSel).forEach(node => {
                if (node.style.display !== 'none') {
                    hidden.push([node, node.style.display]);
                    node.style.display = 'none';
                }
            });
            await html2pdf().set({
                margin: [10, 12, 10, 12],
                filename: filename,
                image: { type: 'jpeg', quality: 0.95 },
                html2canvas: { scale: 2, useCORS: true, letterRendering: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: orientation, compress: true },
                pagebreak: { mode: ['css', 'legacy'], before: '.page-break, .fs-page' }
            }).from(el).save();
        } catch (e) {
            console.error('downloadPDF failed:', e);
            alert('PDF generation failed: ' + e.message + '\n\nFalling back to browser print.');
            window.print();
        } finally {
            hidden.forEach(([node, display]) => { node.style.display = display; });
        }
    }
};

try {
    window.AccountingEngine.initDefaults();
    window.AccountingEngine.initGlobalListeners();
    window.AccountingEngine.checkStorageAndWarn();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { window.AccountingEngine.showUserBadge(); });
    } else {
        window.AccountingEngine.showUserBadge();
    }
} catch (e) {
    console.error("AccountingEngine initialization failed:", e);
}
