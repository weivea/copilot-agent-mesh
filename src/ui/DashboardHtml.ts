import * as vscode from 'vscode';

export function createDashboardHtml(
	webview: vscode.Webview,
	mediaRoot: vscode.Uri,
	uiInstanceId: string,
	nonce: string,
	language = 'en',
): string {
	const chinese = /^zh(?:-|$)/iu.test(language);
	const uri = (name: string) => escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name)).toString());
	const text = chinese
		? { refresh: '刷新本机', navigation: '主导航', overview: '概览', history: '任务历史', access: '设备与权限', loading: '正在加载…' }
		: { refresh: 'Refresh local', navigation: 'Main navigation', overview: 'Overview', history: 'Task history', access: 'Devices & permissions', loading: 'Loading…' };
	return `<!DOCTYPE html>
<html lang="${chinese ? 'zh-CN' : 'en'}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeAttribute(webview.cspSource)}; style-src ${escapeAttribute(webview.cspSource)}; script-src 'nonce-${escapeAttribute(nonce)}';">
	<link rel="stylesheet" href="${uri('dashboard.css')}">
	<title>Agent Mesh</title>
</head>
<body data-ui-instance-id="${escapeAttribute(uiInstanceId)}" data-language="${chinese ? 'zh' : 'en'}">
	<header class="dashboardHeader"><h1>Agent Mesh</h1><button id="refreshButton" type="button">${text.refresh}</button></header>
	<nav id="primaryNav" aria-label="${text.navigation}">
		<button type="button" data-route="overview" aria-current="page">${text.overview}</button>
		<button type="button" data-route="history">${text.history}</button>
		<button type="button" data-route="access">${text.access}</button>
	</nav>
	<div id="operationStatus" role="status" aria-live="polite"></div>
	<main id="pageScroll" tabindex="-1"><div id="pageContent"><p class="empty">${text.loading}</p></div></main>
	<aside id="helpPopover" class="helpPopover" role="dialog" aria-modal="false" hidden></aside>
	<script nonce="${escapeAttribute(nonce)}" src="${uri('dashboard.l10n.js')}"></script>
	<script nonce="${escapeAttribute(nonce)}" src="${uri('dashboard.js')}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
	return value.replace(/[&<>"']/gu, (character) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character]!);
}
