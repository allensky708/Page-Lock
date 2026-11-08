import { getLanguage } from 'obsidian';

/**
 * Minimal, dependency-free i18n for Page Lock.
 *
 * English UI strings are the translation keys; `zh` maps them to Simplified
 * Chinese. Missing entries fall back to English. Placeholders use `{name}`.
 */

export type LanguageSetting = 'auto' | 'en' | 'zh';
export type Locale = 'en' | 'zh';

const zh: Record<string, string> = {
	'Unlock "{name}"?': '解锁“{name}”？',
	'The note will become editable again.': '解锁后笔记将恢复可编辑。',
	Unlock: '解锁',
	Cancel: '取消',

	'Toggle lock on current file': '切换当前文件的锁定状态',
	'Unlock note': '解锁笔记',
	'Lock note': '锁定笔记',
	'Unlock canvas': '解锁白板',
	'Lock canvas': '锁定白板',

	'Locked "{name}"': '已锁定“{name}”',
	'Unlocked "{name}"': '已解锁“{name}”',
	'Page Lock: could not update "{name}"': 'Page Lock：无法更新“{name}”',
	'Page Lock: links in "{name}" changed before the rename could update them; the note was left unchanged.':
		'Page Lock：“{name}”中的链接在重命名更新前发生了变化，笔记未做修改。',
	'"{name}" is locked — unlock to edit': '“{name}”已锁定 — 解锁后才能编辑',
	'"{name}" is locked and cannot be deleted. Unlock it first, or turn off "Block deletion".': '“{name}”已锁定，不允许删除。请先解锁后再删除，或关闭“禁止删除”限制。',
	'"{name}" is locked — unlock it from the file menu to view': '“{name}”已锁定 — 请从文件菜单解锁后查看',
	'Locked canvas "{name}"': '已锁定白板“{name}”',
	'Unlocked canvas "{name}"': '已解锁白板“{name}”',

	'Locked — {action} to unlock': '已锁定 — {action}解锁',
	tap: '轻点',
	click: '点击',

	'Lock property name': '锁定属性名',
	'Frontmatter property that marks a note as locked. The lock travels with the note, so it syncs to other devices. Existing notes keep any previously used property.':
		'用于标记笔记已锁定的 frontmatter 属性。锁定状态会随笔记同步到其他设备；已有笔记会保留之前使用的属性。',
	'Show locked-note banner': '显示锁定提示横幅',
	'Show the locked-note banner above the note. Turn off to use only the header lock icon; editing protection stays active.':
		'在笔记上方显示锁定提示横幅。关闭后仅使用标题栏的锁图标，编辑保护仍然生效。',
	'Allow automatic link updates': '允许自动更新链接',
	'Allow Obsidian to update links in locked notes when linked files are renamed or moved. Only the affected links change; other edits stay blocked. Turn off to keep those links unchanged.':
		'允许 Obsidian 在链接文件重命名或移动时更新已锁定笔记中的链接。仅修改受影响的链接，其他编辑仍会被阻止。关闭后这些链接保持不变。',
	'Confirm before unlocking': '解锁前确认',
	'Ask for confirmation before unlocking a note, preventing accidental unlocks from a stray tap.':
		'解锁笔记前先请求确认，避免误触导致意外解锁。',

	'Enter password to unlock': '输入解锁密码',
	Password: '密码',
	'Incorrect password': '密码错误',
	'Unlock password': '解锁密码',
	'A password is set. Unlocking requires it.': '已设置密码，解锁时需要验证。',
	'Set a password to require verification before unlocking a note or canvas. Only a hash is stored.':
		'设置密码后，解锁笔记或白板前需要验证；仅保存密码哈希。',
	'Set password': '设置密码',
	'Change password': '修改密码',
	'Clear password': '清除密码',
	'Current password': '当前密码',
	'New password': '新密码',
	'Confirm new password': '确认新密码',
	Save: '保存',
	'Password must be at least 4 characters.': '密码至少需要 4 个字符。',
	'Passwords do not match.': '两次输入的密码不一致。',
	'Current password is incorrect.': '当前密码错误。',
	'Password set.': '密码已设置。',
	'Password cleared.': '密码已清除。',

	'Lock restrictions': '锁定限制',
	'Block viewing': '禁止查看',
	'When locked, close the file instead of showing its content in Obsidian. The file is still readable by other apps and search.':
		'锁定后关闭文件，不在 Obsidian 中显示内容。文件仍可能被其他应用或搜索读取。',
	'Block manual editing': '禁止手动编辑',
	'Make the editor read-only while the file is locked.': '锁定时编辑器只读，无法手动修改。',
	'Block plugin edits': '禁止插件编辑',
	'Reject writes from other plugins while the file is locked. Manual saves are also rejected when this is on.':
		'锁定时拒绝其他插件写入；开启此项时手动保存也会被拒绝。',
	'Block deletion': '禁止删除',
	'Reject deleting the locked file inside Obsidian.': '在 Obsidian 内拒绝删除锁定文件。',

	Language: '语言',
	"Choose the language used by Page Lock. Follow Obsidian keeps it in sync with Obsidian's language.":
		'选择 Page Lock 的界面语言。“跟随 Obsidian”会与 Obsidian 的语言保持一致。',
	'Follow Obsidian': '跟随 Obsidian',
	'Language changed. Restart Obsidian to update command names.': '语言已切换。重启 Obsidian 后命令名称才会更新。',
};

function detectLocale(): Locale {
	try {
		const language = getLanguage();
		if (language) return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
	} catch {
		// Test stubs may not implement getLanguage().
	}
	try {
		const language = typeof navigator !== 'undefined' ? navigator.language : '';
		if (language) return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
	} catch {
		// Ignore missing navigator.
	}
	return 'en';
}

let current: Locale = detectLocale();

export function initLocale(setting: unknown): Locale {
	current = setting === 'en' || setting === 'zh' ? setting : setting === 'auto' ? detectLocale() : detectLocale();
	return current;
}

export function getLocale(): Locale {
	return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
	let text = current === 'zh' ? (zh[key] ?? key) : key;
	if (vars) {
		text = text.replace(/\{(\w+)\}/g, (match, name: string) =>
			name in vars ? String(vars[name]) : match,
		);
	}
	return text;
}
