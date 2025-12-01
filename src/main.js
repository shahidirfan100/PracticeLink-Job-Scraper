// PracticeLink jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            specialty = '', state = '', city = '', jobType = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://jobs.practicelink.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const cleanHtml = (html) => {
            if (!html) return '';
            // Normalize quotes and decode common entities up front
            const normalized = html
                .replace(/\/'/g, "'")
                .replace(/\/"/g, '"')
                .replace(/&nbsp;/gi, ' ');

            const $ = cheerioLoad(normalized);
            $('script, style, noscript, iframe').remove();

            const allowed = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'a']);

            $('*').each((_, el) => {
                const tag = el.tagName?.toLowerCase?.() || '';

                // Strip all attributes; allow only href on anchors
                for (const attr of Object.keys(el.attribs || {})) {
                    if (tag === 'a' && attr === 'href') {
                        const href = $(el).attr('href');
                        $(el).attr('href', href ? href.trim() : '');
                    } else {
                        $(el).removeAttr(attr);
                    }
                }

                // Flatten unwanted tags but keep their text/children
                if (tag && !allowed.has(tag)) {
                    $(el).replaceWith($(el).contents());
                }
            });

            // Drop empty containers
            $('p, li').each((_, el) => { if (!$(el).text().trim()) $(el).remove(); });

            let cleaned = $.root().html() || '';
            cleaned = cleaned
                .replace(/\s+/g, ' ')  // Normalize whitespace
                .replace(/>\s+</g, '><')  // Remove whitespace between tags
                .trim();

            return cleaned;
        };

        const cleanTitle = (title) => {
            if (!title) return '';

            // First, try to extract just the core job title before any separators
            let cleaned = title.replace(/\s+/g, ' ').trim();

            // Handle explicit "job at/in/for" patterns (e.g., "Urologist Job at ...")
            const jobPattern = /(.+?)\s+job\b(?:\s+(?:at|in|for|with)[\s\S]*)?$/i;
            const jobMatch = cleaned.match(jobPattern);
            if (jobMatch && jobMatch[1]) {
                const candidate = jobMatch[1].trim();
                if (candidate.length >= 3 && candidate.length <= 80) return candidate;
            }

            // Split on common separators and take the first part
            const separators = [' - ', ' | ', ' at ', ' in ', ' with ', ' for ', ' Job'];
            for (const sep of separators) {
                if (cleaned.includes(sep)) {
                    const parts = cleaned.split(sep);
                    if (parts[0] && parts[0].trim().length > 3 && parts[0].trim().length < 50) {
                        cleaned = parts[0].trim();
                        break;
                    }
                }
            }

            // Remove common suffixes with regex
            cleaned = cleaned
                .replace(/\s+Job\s*$/i, '')  // Remove trailing "Job"
                .replace(/\s+Position\s*$/i, '')  // Remove trailing "Position"
                .replace(/\s+Opening\s*$/i, '')  // Remove trailing "Opening"
                .replace(/\s+Opportunity\s*$/i, '')  // Remove trailing "Opportunity"
                .trim();

            // If the title contains medical specialty patterns, extract just the specialty
            const medicalPatterns = [
                /(Physician|Doctor|Dr\.?)\s+(.+?)(?:\s+at|\s+in|\s+with|$)/i,
                /(Nurse\s+Practitioner|Physician\s+Assistant|Nurse\s+Anesthetist)\s+(.+?)(?:\s+at|\s+in|$)/i,
                /(.+?)\s+(Physician|Doctor|Specialist|Surgeon|Therapist)(?:\s+at|\s+in|$)/i
            ];

            for (const pattern of medicalPatterns) {
                const match = title.match(pattern);
                if (match && match[1] && match[1].length > 3 && match[1].length < 50) {
                    // Return the most relevant part (usually the specialty or role)
                    const extracted = match[1].includes('Physician') || match[1].includes('Doctor') || match[1].includes('Nurse') || match[1].includes('Assistant')
                        ? match[1] + (match[2] ? ' ' + match[2] : '')
                        : (match[2] || match[1]);
                    if (extracted && extracted.length > 3 && extracted.length < 50) {
                        return extracted.trim();
                    }
                }
            }

            // Final cleanup
            cleaned = cleaned.replace(/\s+/g, ' ').trim();

            // Ensure reasonable length
            return cleaned.length > 100 ? cleaned.substring(0, 100).trim() : cleaned;
        };

        const buildStartUrl = (spec, st, ct, jType) => {
            const u = new URL('https://jobs.practicelink.com/jobboard/jobsearchresults');
            if (spec) u.searchParams.set('specialty', String(spec).trim());
            if (st) u.searchParams.set('state', String(st).trim());
            if (ct) u.searchParams.set('city', String(ct).trim());
            if (jType) u.searchParams.set('jobtype', String(jType).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(specialty, state, city, jobType));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            // PracticeLink job links pattern: /jobs/[jobId]/[specialty]/[role]/[state]/[company]
            // Also look for links containing job details
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                
                // Check for job detail URLs
                if (/\/jobs\/\d+\//i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
                // Also check for links that might contain job information
                else if (/jobs\.practicelink\.com/i.test(href) && !/search|browse|about|contact/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base, currentPageNo) {
            // PracticeLink uses numbered pagination
            const nextPageNo = currentPageNo + 1;
            
            // Look for pagination links
            const paginationLinks = $('a[href*="page="], a[href*="p="], .pagination a, [class*="pagination"] a');
            let nextUrl = null;
            
            paginationLinks.each((_, link) => {
                const href = $(link).attr('href');
                const text = $(link).text().trim();
                
                // Check if this is the next page number
                if (text === nextPageNo.toString() || href.includes(`page=${nextPageNo}`) || href.includes(`p=${nextPageNo}`)) {
                    nextUrl = toAbs(href, base);
                    return false; // break out of each loop
                }
            });
            
            // Fallback: look for "next" button
            if (!nextUrl) {
                const nextBtn = $('a[rel="next"], a:contains("Next"), a:contains("›"), a:contains(">"), .next, [class*="next"]').first();
                if (nextBtn.length) {
                    nextUrl = toAbs(nextBtn.attr('href'), base);
                }
            }
            
            return nextUrl;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'practicelink.com' }))); saved += toPush.length; }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url, pageNo);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // Extract from HTML if JSON-LD not available
                        if (!data.title) {
                            // Try more specific selectors for job titles
                            let rawTitle = null;

                            // Try h1 elements first (most common for job titles)
                            const h1Title = $('h1').first().text().trim();
                            if (h1Title && h1Title.length > 3 && h1Title.length < 100) {
                                rawTitle = h1Title;
                            }

                            // Try job-title specific classes
                            if (!rawTitle) {
                                const jobTitleEl = $('.job-title, [class*="job-title"], [class*="position-title"]').first();
                                if (jobTitleEl.length) {
                                    rawTitle = jobTitleEl.text().trim();
                                }
                            }

                            // Try to extract from URL path as fallback
                            if (!rawTitle) {
                                const urlParts = request.url.split('/');
                                // URL format: /jobs/12345/specialty/role/state/company
                                if (urlParts.length >= 5) {
                                    const specialty = urlParts[4] ? urlParts[4].replace(/-/g, ' ') : '';
                                    const role = urlParts[5] ? urlParts[5].replace(/-/g, ' ') : '';
                                    if (role && specialty) {
                                        rawTitle = `${role} ${specialty}`.replace(/\b\w/g, l => l.toUpperCase());
                                    } else if (specialty) {
                                        rawTitle = specialty.replace(/\b\w/g, l => l.toUpperCase());
                                    }
                                }
                            }

                            // Try page title as last resort
                            if (!rawTitle) {
                                const pageTitle = $('title').text().trim();
                                if (pageTitle) {
                                    rawTitle = pageTitle;
                                }
                            }

                            data.title = rawTitle ? cleanTitle(rawTitle) : null;
                        }
                        if (!data.company) data.company = $('[class*="company"], .company-name, [class*="employer"], [class*="organization"]').first().text().trim() || null;
                        if (!data.location) data.location = $('[class*="location"], .job-location, [class*="address"]').first().text().trim() || null;
                        if (!data.job_type) data.job_type = $('[class*="job-type"], [class*="employment-type"], [class*="schedule"]').first().text().trim() || null;
                        if (!data.salary) data.salary = $('[class*="salary"], [class*="compensation"], [class*="pay"]').first().text().trim() || null;
                        
                        // Extract description with better selectors
                        if (!data.description_html) { 
                            // Try multiple selectors for job description
                            const descSelectors = [
                                '[class*="job-description"]',
                                '.job-description',
                                '.description',
                                '[class*="job-details"]',
                                '[class*="job-content"]',
                                '[class*="position-details"]',
                                '.content',
                                '.main-content'
                            ];
                            
                            let descElement = null;
                            for (const selector of descSelectors) {
                                descElement = $(selector).first();
                                if (descElement.length && descElement.html().trim()) break;
                            }
                            
                            if (descElement && descElement.length) {
                                const rawHtml = descElement.html().trim();
                                data.description_html = cleanHtml(rawHtml);
                            } else {
                                data.description_html = null;
                            }
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        
                        // Extract specialty from URL or content
                        const urlParts = request.url.split('/');
                        const specialtyFromUrl = urlParts.length > 4 ? urlParts[4].replace(/-/g, ' ') : null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            specialty: specialty || specialtyFromUrl || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
