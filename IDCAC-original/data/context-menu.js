// Vars

var cached_rules = {},
	whitelisted_domains = {},
	cookie_warning_dismissed_domains = {},
	tab_list = {},
	xml_tabs = {};


// FF only: debugging mode
var debug_mode = false;


// Common functions

function getHostname(url, cleanup)
{
	try
	{
		if (url.indexOf('http') != 0)
			throw true;
		
		var a = new URL(url);
		
		return (typeof cleanup == 'undefined' ? a.hostname : a.hostname.replace(/^w{2,3}\d*\./i, ''));
	}
	catch(error)
	{
		return false;
	}
}


// Badges

function setBadge(tabId, text) {
	if (!chrome.browserAction.setBadgeText)
		return;
	
	chrome.browserAction.setBadgeText({text: text || '', tabId: tabId});
	
	if (chrome.browserAction.setBadgeBackgroundColor)
		chrome.browserAction.setBadgeBackgroundColor({color: '#646464', tabId: tabId});
}

function setSuccessBadge(tabId) {
	setBadge(tabId, '✅');
}

function setDisabledBadge(tabId) {
	setBadge(tabId, '⛔');
}

function resetBadge(tabId) {
	setBadge(tabId);
}


// Whitelisting

function updateWhitelist()
{
	chrome.storage.local.get('whitelisted_domains', function(r) {
		if (typeof r.whitelisted_domains != 'undefined')
			whitelisted_domains = r.whitelisted_domains;
	});
}

updateWhitelist();

chrome.runtime.onMessage.addListener(function(request, info){
	if (request == 'update_whitelist')
		updateWhitelist();
});

function isWhitelisted(tab)
{
	if (typeof whitelisted_domains[tab.hostname] != 'undefined')
		return true;
	
	for (var i in tab.host_levels)
		if (typeof whitelisted_domains[tab.host_levels[i]] != 'undefined')
			return true;
	
	return false;
}

function getWhitelistedDomain(tab)
{
	if (typeof whitelisted_domains[tab.hostname] != 'undefined')
		return tab.hostname;
	
	for (var i in tab.host_levels)
		if (typeof whitelisted_domains[tab.host_levels[i]] != 'undefined')
			return tab.host_levels[i];
	
	return false;
}

function toggleWhitelist(tab)
{
	if (tab.url.indexOf('http') != 0 || !tab_list[tab.id])
		return;
	
	if (tab_list[tab.id].whitelisted)
	{
		var hostname = getWhitelistedDomain(tab_list[tab.id]);
		delete whitelisted_domains[tab_list[tab.id].hostname];
	}
	else
		whitelisted_domains[tab_list[tab.id].hostname] = true;
	
	chrome.storage.local.set({'whitelisted_domains': whitelisted_domains}, function(){
		for (var i in tab_list)
			if (tab_list[i].hostname == tab_list[tab.id].hostname)
				tab_list[i].whitelisted = !tab_list[tab.id].whitelisted;
	});
}


// Maintain tab list

function getPreparedTab(tab)
{
	tab.hostname = false;
	tab.whitelisted = false;
	tab.host_levels = [];
	
	if (tab.url)
	{
		tab.hostname = getHostname(tab.url, true);
		
		if (tab.hostname)
		{
			var parts = tab.hostname.split('.');
			
			for (var i=parts.length; i>=2; i--)
				tab.host_levels.push(parts.slice(-1*i).join('.'));
			
			tab.whitelisted = isWhitelisted(tab);
			
			if (tab.whitelisted)
				setDisabledBadge(tab.id || tab.tabId);
			else if (cookie_warning_dismissed_domains[tab.hostname])
				setSuccessBadge(tab.id || tab.tabId);
		}
	}
	
	return tab;
}

function onCreatedListener(tab)
{
	resetBadge(tab.id);
	
	tab_list[tab.id] = getPreparedTab(tab);
}

function onUpdatedListener(tabId, changeInfo, tab) {
	if (changeInfo.status)
		tab_list[tab.id] = getPreparedTab(tab);
}

function onRemovedListener(tabId) {
    if (tab_list[tabId])
		delete tab_list[tabId];
}

function recreateTabList()
{
	tab_list = {};
	
	chrome.tabs.query({}, function(results) {
		results.forEach(onCreatedListener);
		
		for (var i in tab_list)
			doTheMagic(tab_list[i].id);
	});
}

chrome.tabs.onCreated.addListener(onCreatedListener);
chrome.tabs.onUpdated.addListener(onUpdatedListener);
chrome.tabs.onRemoved.addListener(onRemovedListener);

chrome.runtime.onStartup.addListener(function(d){
	cached_rules = {};
	recreateTabList();
});

chrome.runtime.onInstalled.addListener(function(d){
	cached_rules = {};
	
	if (d.reason == "update" && chrome.runtime.getManifest().version > d.previousVersion)
		recreateTabList();
	
	
	// FF only: debugging mode
	
	if (d.temporary && d.temporary === true)
	{
		recreateTabList();
		debug_mode = true;
		
		chrome.notifications.create('debug', {
			type: "basic",
			title: "IDCAC debugging mode",
			message: "You have installed IDCAC in debugging mode. You will be notified when custom rules get applied to websites.",
			iconUrl: "icons/48.png"
		});
	}
});


// URL blocking

function blockUrlCallback(d)
{
	// Cached request: find the appropriate tab
	
	if (d.tabId == -1 && d.initiator) {
		let hostname = getHostname(d.initiator, true);
		
		for (let tabId in tab_list) {
			if (tab_list[tabId].hostname == getHostname(d.initiator, true)) {
				d.tabId = parseInt(tabId);
				break;
			}
		}
	}
	
	
	if (tab_list[d.tabId] && !tab_list[d.tabId].whitelisted && d.url)
	{
		var clean_url = d.url.split('?')[0];
		
		
		// To shorten the checklist, many filters are grouped by keywords
		
		for (var group in block_urls.common_groups)
		{
			if (d.url.indexOf(group) > -1)
			{
				var group_filters = block_urls.common_groups[group];
				
				for (var i in group_filters)
				{
					if ((group_filters[i].q && d.url.indexOf(group_filters[i].r) > -1) || (!group_filters[i].q && clean_url.indexOf(group_filters[i].r) > -1))
					{
						// Check for exceptions
						
						if (group_filters[i].e && tab_list[d.tabId].host_levels.length > 0)
							for (var level in tab_list[d.tabId].host_levels)
								for (var exception in group_filters[i].e)
									if (group_filters[i].e[exception] == tab_list[d.tabId].host_levels[level])
										return {cancel:false};
						
						if (debug_mode) {
							chrome.notifications.create('request_blocked', {
								type: "basic",
								title: "IDCAC debugging mode",
								message: "Block pattern found: " + group_filters[i].r,
								iconUrl: "icons/48.png"
							});
						}
						
						setSuccessBadge(d.tabId);
						
						return {cancel:true};
					}
				}
			}
		}
		
		
		// Check ungrouped filters
		
		var group_filters = block_urls.common;
		
		for (var i in group_filters)
		{
			if ((group_filters[i].q && d.url.indexOf(group_filters[i].r) > -1) || (!group_filters[i].q && clean_url.indexOf(group_filters[i].r) > -1))
			{
				// Check for exceptions
				
				if (group_filters[i].e && tab_list[d.tabId].host_levels.length > 0)
					for (var level in tab_list[d.tabId].host_levels)
						for (var exception in group_filters[i].e)
							if (group_filters[i].e[exception] == tab_list[d.tabId].host_levels[level])
								return {cancel:false};
				
				if (debug_mode) {
					chrome.notifications.create('request_blocked', {
						type: "basic",
						title: "IDCAC debugging mode",
						message: "Block pattern found: " + group_filters[i].r,
						iconUrl: "icons/48.png"
					});
				}
				
				setSuccessBadge(d.tabId);
				
				return {cancel:true};
			}
		}
		
		
		// Site specific filters
		
		if (d.tabId > -1 && tab_list[d.tabId].host_levels.length > 0)
		{
			for (var level in tab_list[d.tabId].host_levels)
			{
				if (block_urls.specific[tab_list[d.tabId].host_levels[level]])
				{
					var rules = block_urls.specific[tab_list[d.tabId].host_levels[level]];
					
					for (var i in rules)
					{
						if (d.url.indexOf(rules[i]) > -1)
						{
							if (debug_mode)
							{
								chrome.notifications.create('blocked', {
									type: "basic",
									title: "IDCAC debugging mode",
									message: "Site specific block pattern found: " + rules[i],
									iconUrl: "icons/48.png"
								});
							}
							
							setSuccessBadge(d.tabId);
							
							return {cancel:true};
						}
					}
				}
			}
		}
	}
	
	return {cancel:false};
}

chrome.webRequest.onBeforeRequest.addListener(blockUrlCallback, {urls:["http://*/*", "https://*/*"], types:["script","stylesheet","xmlhttprequest"]}, ["blocking"]);


// Detect content type (XML related Firefox bug)

chrome.webRequest.onHeadersReceived.addListener(function(d) {
	if (tab_list[d.tabId]) {
		d.responseHeaders.forEach(function(h) {
			if (h.name == "Content-Type" || h.name == "content-type") {
				xml_tabs[d.tabId] = h.value.indexOf("/xml") > -1;
			}
		});
	}
	
	return {cancel:false};
}, {urls:["http://*/*", "https://*/*"], types:["main_frame"]}, ["blocking", "responseHeaders"]);


// Reporting

function reportWebsite(info, tab)
{
	if (tab.url.indexOf('http') != 0 || !tab_list[tab.id])
		return;
	
	
	var hostname = getHostname(tab.url);
	
	if (hostname.length == 0)
		return;
	
	
	if (tab_list[tab.id].whitelisted)
	{
		return chrome.notifications.create('report', {
			type: "basic",
			title: chrome.i18n.getMessage("reportSkippedTitle", hostname),
			message: chrome.i18n.getMessage("reportSkippedMessage"),
			iconUrl: "icons/48.png"
		});
	}
	
	
	chrome.tabs.create({url:"https://www.i-dont-care-about-cookies.eu/report/"+chrome.runtime.getManifest().version+'/'+encodeURIComponent(encodeURIComponent(tab.url))});
}


// Adding custom CSS/JS

function activateDomain(hostname, tabId, frameId)
{
	if (!cached_rules[hostname])
		cached_rules[hostname] = rules[hostname] || {};
	
	if (!cached_rules[hostname])
		return false;
	
	let r = cached_rules[hostname],
		status = false;
	
	if (typeof r.s != 'undefined') {
		chrome.tabs.insertCSS(tabId, {code: r.s, frameId: frameId, runAt: xml_tabs[tabId] ? 'document_idle' : 'document_start'});
		status = true;
	}
	else if (typeof r.c != 'undefined') {
		chrome.tabs.insertCSS(tabId, {code: commons[r.c], frameId: frameId, runAt: xml_tabs[tabId] ? 'document_idle' : 'document_start'});
		status = true;
	}
	
	if (typeof r.j != 'undefined') {
		chrome.tabs.executeScript(tabId, {file: 'data/js/'+(r.j > 0 ? 'common'+r.j : hostname)+'.js', frameId: frameId, runAt: xml_tabs[tabId] ? 'document_idle' : 'document_end'});
		status = true;
	}
	
	if (!status)
		return false;
	
	
	setSuccessBadge(tabId);
	
	
	// FF only: debugging mode
	
	if (debug_mode && !frameId)
	{
		chrome.notifications.create('applied', {
			type: "basic",
			title: "IDCAC debugging mode",
			message: "Custom rule applied on " + hostname,
			iconUrl: "icons/48.png"
		});
	}
	
	return true;
}


function doTheMagic(tabId, frameId, anotherTry)
{
	if (!tab_list[tabId] || tab_list[tabId].url.indexOf('http') != 0)
		return;
	
	if (tab_list[tabId].whitelisted)
		return;
	
	// Common CSS rules
	chrome.tabs.insertCSS(tabId, {file: "data/css/common.css", frameId: frameId || 0, runAt: xml_tabs[tabId] ? 'document_idle' : 'document_start'}, function() {
	
		// A failure? Retry.
		
		if (chrome.runtime.lastError) {
			let currentTry = (anotherTry || 1);
			
			if (currentTry == 5)
				return;
			
			setTimeout(function() {
				doTheMagic(tabId, frameId || 0, currentTry + 1)
			}, 300);
			
			return;
		}
		
		
		// Common social embeds
		chrome.tabs.executeScript(tabId, {file:'data/js/embeds.js', frameId: frameId || 0, runAt: xml_tabs[tabId] ? 'document_idle' : 'document_end'}, function() {});
		
		if (activateDomain(tab_list[tabId].hostname, tabId, frameId || 0))
			return;
		
		for (var level in tab_list[tabId].host_levels)
			if (activateDomain(tab_list[tabId].host_levels[level], tabId, frameId || 0))
				return true;
		
		// Common JS rules when custom rules don't exist
		chrome.tabs.executeScript(tabId, {file:'data/js/common.js', frameId: frameId || 0, runAt: xml_tabs[tabId] ? 'document_idle' : 'document_end'}, function() {});
	});
}


chrome.webNavigation.onCommitted.addListener(function(tab) {
	if (tab.frameId > 0)
		return;
	
	resetBadge(tab.tabId);

	tab_list[tab.tabId] = getPreparedTab(tab);
	
	doTheMagic(tab.tabId);
});


chrome.webRequest.onResponseStarted.addListener(function(tab) {
	if (tab.frameId > 0)
		doTheMagic(tab.tabId, tab.frameId);
}, {urls: ['<all_urls>'], types: ['sub_frame']});


// FF only

chrome.webRequest.onResponseStarted.addListener(function(tab) {
	doTheMagic(tab.tabId, tab.frameId);
}, {urls: ['https://consent.google.com/*', 'https://consent.youtube.com/*'], types: ['beacon']});


// Update notification

chrome.runtime.onInstalled.addListener(function(d){
	if (d.reason == "update" && chrome.runtime.getManifest().version > d.previousVersion)
	{
		chrome.browserAction.setIcon({path: "icons/32.gif"});
		
		setTimeout(function(){
			chrome.browserAction.setIcon({path: "icons/32.png"});
		}, 4000);
		
		chrome.tabs.create({url:"https://www.i-dont-care-about-cookies.eu/whats-new/acquisition/"});
		
// 		chrome.notifications.create('update', {
// 			type: "basic",
// 			title: "Big summer update - I don't care about cookies",
// 			message: "Support the project, please. Visit i-dont-care-about-cookies.eu",
// 			iconUrl: "icons/48.png"
// 		});
	}
	
	if (d.reason == "install") {
		chrome.storage.local.get('is_installed', function(r) {
			if (typeof r.is_installed == 'undefined') {
				chrome.storage.local.set({'is_installed': true}, function() {
					// chrome.tabs.create({url:"https://www.i-dont-care-about-cookies.eu"});
				});
			}
		});
	}
});


// Toolbar menu

chrome.runtime.onMessage.addListener(function(request, info, sendResponse) {
	if (typeof request == 'object')
	{
		if (request.tabId && tab_list[request.tabId])
		{
			if (request.command == 'get_active_tab')
			{
				var response = {tab: tab_list[request.tabId]};
				
				if (response.tab.whitelisted)
					response.tab.hostname = getWhitelistedDomain(tab_list[request.tabId]);
				
				sendResponse(response);
			}
			else if (request.command == 'toggle_extension')
				toggleWhitelist(tab_list[request.tabId]);
			else if (request.command == 'report_website')
				chrome.tabs.create({url:"https://www.i-dont-care-about-cookies.eu/report/"+chrome.runtime.getManifest().version+'/'+encodeURIComponent(encodeURIComponent(tab_list[request.tabId].url))});
			else if (request.command == 'refresh_page')
				chrome.tabs.executeScript(request.tabId, {code:'window.location.reload();'});
		}
		else
		{
			if (request.command == 'open_support_page')
				chrome.tabs.create({url:"https://www.i-dont-care-about-cookies.eu/"});
			else if (request.command == 'open_options_page')
				chrome.tabs.create({url:chrome.runtime.getURL('data/options.html')});
			else if (request.command == 'cookie_warning_dismissed' && request.url)
				cookie_warning_dismissed_domains[getHostname(request.url, true)] = true;
		}
	}
});