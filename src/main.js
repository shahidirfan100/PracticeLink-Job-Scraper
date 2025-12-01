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
            // Fix escaped quotes and clean up Microsoft Word styling
            let cleaned = html
                .replace(/\/'/g, "'")  // Fix escaped single quotes
                .replace(/\/"/g, '"')  // Fix escaped double quotes
                .replace(/mso-[^;]+;?/g, '')  // Remove MSO styling
                .replace(/font-notused:[^;]+;?/g, '')  // Remove font-notused
                .replace(/background-notused:[^;]+;?/g, '')  // Remove background-notused
                .replace(/color-notused:[^;]+;?/g, '')  // Remove color-notused
                .replace(/mso-color-alt:[^;]+;?/g, '')  // Remove mso-color-alt
                .replace(/mso-bidi-font-weight:[^;]+;?/g, '')  // Remove mso-bidi-font-weight
                .replace(/mso-fareast-font-family:[^;]+;?/g, '')  // Remove mso-fareast-font-family
                .replace(/mso-font-kerning:[^;]+;?/g, '')  // Remove mso-font-kerning
                .replace(/mso-ligatures:[^;]+;?/g, '')  // Remove mso-ligatures
                .replace(/mso-spacerun:yes\/?/g, '')  // Remove mso-spacerun
                .replace(/\s+/g, ' ')  // Normalize whitespace
                .replace(/>\s+</g, '><')  // Remove whitespace between tags
                .trim();
            
            // Remove empty style attributes
            cleaned = cleaned.replace(/\s+style=""\s*/g, '');
            cleaned = cleaned.replace(/\s+class=""\s*/g, '');
            
            return cleaned;
        };

        const cleanTitle = (title) => {
            if (!title) return '';
            // Remove common suffixes like "Job at Company in Location"
            return title
                .replace(/\s+Job\s+at\s+.*$/i, '')  // Remove "Job at Company in Location"
                .replace(/\s+at\s+.*$/i, '')  // Remove "at Company in Location" 
                .replace(/\s+in\s+.*$/i, '')  // Remove "in Location"
                .trim();
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
                            const rawTitle = $('h1, .job-title, [class*="job-title"]').first().text().trim() || 
                                           $('title').text().trim() || 
                                           null;
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
