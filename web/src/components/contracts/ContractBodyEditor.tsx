'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { useEditor, EditorContent, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Button } from '@/components/ui/Button';
import type { ComposeBlock } from '@/types/api';

/**
 * 계약서 본문 리치 에디터(TipTap) — 문서 제목(H1)·조항 제목(H2)·본문·굵게가 화면에 그대로 보이는 편집기.
 * PDF 조판(compose doc 블록)과 1:1 매핑: h1=14pt bold, h2=11.5pt bold, 문단=10pt(+굵기 런).
 * 서식 텍스트 로드 시 '제N조 …' 줄은 조항 제목으로, 첫 줄은 문서 제목으로 자동 승격.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface BodyEditorHandle {
  setDocFromText: (text: string) => void; // 서식 치환 결과 재주입(속성 자동 인식)
  insertBlockText: (text: string) => void; // 커서 위치에 단독 문단(마커 토큰) 삽입
  getBlocks: () => ComposeBlock[];
  getPlainText: () => string;
}

/** 플레인 서식 텍스트 → 에디터 문서(첫 줄=제목, 제N조=조항 제목) */
function textToPm(text: string): JSONContent {
  const content: JSONContent[] = [];
  let sawTitle = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { content.push({ type: 'paragraph' }); continue; }
    if (!sawTitle) {
      sawTitle = true;
      content.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: line.trim() }] });
      continue;
    }
    if (/^제\d+조/.test(line.trim())) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: line.trim() }] });
      continue;
    }
    content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
  }
  return { type: 'doc', content };
}

/** 인라인 자식 → 굵기 런 배열(hardBreak 는 공백으로) */
function inlineRuns(node: JSONContent): ComposeBlock['runs'] {
  const runs: ComposeBlock['runs'] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') { runs.push({ text: ' ' }); continue; }
    if (child.type === 'text') runs.push({ text: child.text ?? '', bold: !!child.marks?.some((m) => m.type === 'bold') || undefined });
  }
  return runs;
}

/** 노드 정렬 속성(TextAlign) — 미지정은 undefined(조판 기본값: h1=center, 그 외 left) */
function alignOf(node: JSONContent): 'left' | 'center' | 'right' | undefined {
  const a = node.attrs?.textAlign as string | undefined;
  return a === 'center' || a === 'right' || a === 'left' ? a : undefined;
}

/** 에디터 문서 → compose 블록 — 문단/제목(정렬), 목록(listItem), 표(tableRow) */
function pmToBlocks(json: JSONContent): ComposeBlock[] {
  const blocks: ComposeBlock[] = [];
  const pushRunBlock = (type: 'heading' | 'paragraph', node: JSONContent, level?: number) => {
    // hardBreak 는 문단 분할(기존 동작 유지)
    let runs: ComposeBlock['runs'] = [];
    const flush = () => { blocks.push({ type, level, align: alignOf(node), runs: runs.length ? runs : [{ text: '' }] }); runs = []; };
    for (const child of node.content ?? []) {
      if (child.type === 'hardBreak') { flush(); continue; }
      if (child.type === 'text') runs.push({ text: child.text ?? '', bold: !!child.marks?.some((m) => m.type === 'bold') || undefined });
    }
    flush();
  };
  const walkList = (node: JSONContent, ordered: boolean, depth: number) => {
    let index = 1;
    for (const li of node.content ?? []) {
      if (li.type !== 'listItem') continue;
      for (const child of li.content ?? []) {
        if (child.type === 'paragraph') {
          blocks.push({ type: 'listItem', level: depth, ordered: ordered || undefined, index: ordered ? index : undefined, runs: inlineRuns(child) });
        } else if (child.type === 'bulletList') walkList(child, false, depth + 1);
        else if (child.type === 'orderedList') walkList(child, true, depth + 1);
      }
      index++;
    }
  };
  for (const node of json.content ?? []) {
    if (node.type === 'heading') { pushRunBlock('heading', node, (node.attrs?.level as number) === 1 ? 1 : 2); continue; }
    if (node.type === 'bulletList') { walkList(node, false, 1); continue; }
    if (node.type === 'orderedList') { walkList(node, true, 1); continue; }
    if (node.type === 'table') {
      for (const row of node.content ?? []) {
        if (row.type !== 'tableRow') continue;
        const cells: Array<ComposeBlock['runs']> = [];
        let header = false;
        for (const cell of row.content ?? []) {
          if (cell.type === 'tableHeader') header = true;
          // 셀 안 문단들을 공백으로 이어 하나의 런 열로(셀 내 다문단은 드묾)
          const cellRuns: ComposeBlock['runs'] = [];
          for (const p of cell.content ?? []) {
            if (p.type !== 'paragraph') continue;
            if (cellRuns.length) cellRuns.push({ text: ' ' });
            cellRuns.push(...inlineRuns(p));
          }
          cells.push(cellRuns.length ? cellRuns : [{ text: '' }]);
        }
        blocks.push({ type: 'tableRow', header: header || undefined, cells, runs: [] });
      }
      continue;
    }
    pushRunBlock('paragraph', node);
  }
  return blocks;
}

const MAX_TABLE_COLS = 8; // 서버 조판 상한(contract-template.service 의 셀 1~8개 검증)과 동일

export const ContractBodyEditor = forwardRef<BodyEditorHandle, {
  initialText: string;
  onUpdate: (plainText: string) => void; // 사용자 편집 시(프로그램 주입 제외)
}>(function ContractBodyEditor({ initialText, onUpdate }, ref) {
  const suppress = useRef(false); // setDocFromText 로 인한 update 이벤트 무시

  const editor = useEditor({
    immediatelyRender: false, // Next.js SSR 하이드레이션 경고 방지
    shouldRerenderOnTransaction: true, // 툴바 활성 상태(정렬·목록·표) 실시간 반영 — v3 기본 false 라 미지정 시 stale

    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        // 목록(A5) — 불릿·번호 목록을 PDF 조판(listItem 블록)과 1:1 매핑
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }), // 정렬(A5) — 좌/중/우
      Table.configure({ resizable: false }), // 표(A5) — 균등 열폭(PDF 조판과 일치)
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: textToPm(initialText),
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': '계약서 본문',
        class: 'contract-body-editor',
      },
    },
    onUpdate: ({ editor: e }) => {
      if (suppress.current) { suppress.current = false; return; }
      onUpdate(e.getText({ blockSeparator: '\n' }));
    },
  });

  useImperativeHandle(ref, () => ({
    setDocFromText: (text: string) => {
      if (!editor) return;
      suppress.current = true;
      editor.commands.setContent(textToPm(text));
    },
    insertBlockText: (text: string) => {
      editor?.chain().focus().insertContent([{ type: 'paragraph', content: [{ type: 'text', text }] }]).run();
    },
    getBlocks: () => (editor ? pmToBlocks(editor.getJSON()) : []),
    getPlainText: () => editor?.getText({ blockSeparator: '\n' }) ?? '',
  }), [editor]);

  const tbtn = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-primary,#2563eb)' : 'transparent',
    color: active ? '#fff' : 'var(--color-text)',
    fontWeight: active ? 600 : 400,
  });

  // 커서가 놓인 표의 열 수 — 헤더 행(없으면 첫 행)의 셀 수로 판정(균등 열폭이라 행마다 동일)
  const tableCols = (() => {
    if (!editor?.isActive('table')) return 0;
    const { $from } = editor.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'table') return node.firstChild?.childCount ?? 0;
    }
    return 0;
  })();

  return (
    <div>
      {/* 속성 툴바 — 현재 커서 위치의 속성이 하이라이트됨 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px', border: '1px solid var(--color-border)', borderBottom: 'none', borderRadius: '8px 8px 0 0', background: 'var(--color-bg-secondary,#f8fafc)' }}>
        <button style={tbtn(!!editor?.isActive('heading', { level: 1 }))} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} aria-pressed={!!editor?.isActive('heading', { level: 1 })}>문서 제목</button>
        <button style={tbtn(!!editor?.isActive('heading', { level: 2 }))} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} aria-pressed={!!editor?.isActive('heading', { level: 2 })}>조항 제목</button>
        <button style={tbtn(!!editor?.isActive('paragraph'))} onClick={() => editor?.chain().focus().setParagraph().run()} aria-pressed={!!editor?.isActive('paragraph')}>본문</button>
        <span aria-hidden="true" style={{ color: 'var(--color-border)' }}>|</span>
        <button style={{ ...tbtn(!!editor?.isActive('bold')), fontWeight: 700 }} onClick={() => editor?.chain().focus().toggleBold().run()} aria-pressed={!!editor?.isActive('bold')} aria-label="굵게">B</button>
        <span aria-hidden="true" style={{ color: 'var(--color-border)' }}>|</span>
        {/* 정렬(A5) */}
        <button style={tbtn(!!editor?.isActive({ textAlign: 'left' }))} onClick={() => editor?.chain().focus().setTextAlign('left').run()} aria-pressed={!!editor?.isActive({ textAlign: 'left' })} aria-label="왼쪽 정렬">⯇</button>
        <button style={tbtn(!!editor?.isActive({ textAlign: 'center' }))} onClick={() => editor?.chain().focus().setTextAlign('center').run()} aria-pressed={!!editor?.isActive({ textAlign: 'center' })} aria-label="가운데 정렬">≡</button>
        <button style={tbtn(!!editor?.isActive({ textAlign: 'right' }))} onClick={() => editor?.chain().focus().setTextAlign('right').run()} aria-pressed={!!editor?.isActive({ textAlign: 'right' })} aria-label="오른쪽 정렬">⯈</button>
        <span aria-hidden="true" style={{ color: 'var(--color-border)' }}>|</span>
        {/* 목록(A5) */}
        <button style={tbtn(!!editor?.isActive('bulletList'))} onClick={() => editor?.chain().focus().toggleBulletList().run()} aria-pressed={!!editor?.isActive('bulletList')} aria-label="불릿 목록">•—</button>
        <button style={tbtn(!!editor?.isActive('orderedList'))} onClick={() => editor?.chain().focus().toggleOrderedList().run()} aria-pressed={!!editor?.isActive('orderedList')} aria-label="번호 목록">1.—</button>
        <span aria-hidden="true" style={{ color: 'var(--color-border)' }}>|</span>
        {/* 표(A5) */}
        {editor?.isActive('table') ? (
          <>
            <button style={tbtn(false)} onClick={() => editor?.chain().focus().addRowAfter().run()} aria-label="행 추가">행+</button>
            {/* 서버 조판 상한(8열)을 편집 시점에 강제 — 넘겨 만들면 저장·미리보기에서야 400 이 뜬다(R14) */}
            <button style={tbtn(false)} onClick={() => editor?.chain().focus().addColumnAfter().run()} disabled={tableCols >= MAX_TABLE_COLS} title={tableCols >= MAX_TABLE_COLS ? `표는 최대 ${MAX_TABLE_COLS}열까지 지원합니다` : undefined} aria-label="열 추가">열+</button>
            <button style={tbtn(false)} onClick={() => editor?.chain().focus().deleteRow().run()} aria-label="행 삭제">행−</button>
            <button style={tbtn(false)} onClick={() => editor?.chain().focus().deleteColumn().run()} aria-label="열 삭제">열−</button>
            <button style={tbtn(false)} onClick={() => editor?.chain().focus().deleteTable().run()} aria-label="표 삭제">표✕</button>
          </>
        ) : (
          <button style={tbtn(false)} onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} aria-label="표 삽입">표</button>
        )}
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>제목·굵게·정렬·목록·표가 PDF에 그대로 반영됩니다</span>
      </div>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '0 0 8px 8px', background: 'var(--color-bg,#fff)' }}>
        <EditorContent editor={editor} />
      </div>
      <style>{`
        .contract-body-editor { min-height: 380px; max-height: 60vh; overflow-y: auto; padding: 16px 18px; outline: none; font-size: 14px; line-height: 1.8; color: var(--color-text); }
        .contract-body-editor h1 { font-size: 19px; font-weight: 700; text-align: center; margin: 8px 0 14px; }
        .contract-body-editor h2 { font-size: 15px; font-weight: 700; margin: 14px 0 4px; }
        .contract-body-editor p { margin: 6px 0; }
        .contract-body-editor ul, .contract-body-editor ol { margin: 6px 0; padding-left: 24px; }
        .contract-body-editor table { border-collapse: collapse; width: 100%; margin: 10px 0; table-layout: fixed; }
        .contract-body-editor th, .contract-body-editor td { border: 1px solid var(--color-border); padding: 6px 8px; vertical-align: top; }
        .contract-body-editor th { background: var(--color-bg-secondary,#f1f5f9); font-weight: 700; }
        .contract-body-editor .selectedCell { background: color-mix(in srgb, var(--color-primary,#2563eb) 12%, transparent); }
        .contract-body-editor:focus { box-shadow: inset 0 0 0 2px var(--color-primary, #2563eb); border-radius: 0 0 8px 8px; }
      `}</style>
    </div>
  );
});
