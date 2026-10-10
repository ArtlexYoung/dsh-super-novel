/** Content-first workspace geometry, using the host's components and theme. */
export const styles = `
.super-novel-setup{container:sn-pane / inline-size;display:flex;flex-direction:column;gap:8px;padding:12px 14px;height:100%;overflow:hidden;box-sizing:border-box;min-width:0;min-height:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.super-novel-setup *{box-sizing:border-box}
.super-novel-setup h2{font-size:12px;line-height:20px;margin:0;font-weight:500;color:var(--dsw-alias-label-secondary)}
.super-novel-setup h3{font-size:15px;line-height:24px;margin:0 0 8px;font-weight:600}
.super-novel-setup p{overflow-wrap:anywhere;margin:8px 0}
.super-novel-setup button{font-family:inherit;white-space:normal;max-width:100%;flex-shrink:0}
.super-novel-setup :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sn-input{width:100%;min-width:0}.sn-row>.sn-input{flex:1}
.sn-select{position:relative;display:flex;align-items:center;width:100%;min-width:0;height:34px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.sn-select:focus-within{border-color:var(--dsw-alias-brand-primary)}
.sn-select select{appearance:none;width:100%;height:100%;min-width:0;padding:0 28px 0 10px;border:0;background:transparent;font:inherit;font-size:13px;color:inherit;cursor:pointer;text-overflow:ellipsis}
.sn-select>svg{position:absolute;right:9px;pointer-events:none;color:var(--dsw-alias-label-tertiary)}
.super-novel-setup input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);flex:0 0 16px}
.super-novel-setup input[type=file]{width:100%;min-width:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
.super-novel-setup input[type=file]::file-selector-button{border:0.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);font:inherit;padding:5px 10px;margin-right:8px;cursor:pointer}
.sn-books{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;gap:0}
.sn-books [hidden]{display:none!important}
.sn-library{min-width:0}
.sn-toolbar{display:flex;align-items:center;gap:8px;min-height:28px}
.sn-library-heading{margin-bottom:4px}.sn-library-heading h2{flex:0 1 auto;white-space:nowrap}
.sn-icon{width:28px!important;height:28px!important;padding:0!important;flex:0 0 28px}
.sn-workspace{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.sn-book-picker{display:flex;gap:8px;align-items:center}.sn-book-picker>.sn-select{flex:1;font-weight:600;background:var(--dsw-alias-bg-module-platform);border-color:transparent;height:36px}
.sn-new-book{padding:6px 0}.sn-new-book>button{font-size:12px}
.sn-field{display:grid;gap:6px;margin:12px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.sn-field .sn-input,.sn-field .sn-select{color:var(--dsw-alias-label-primary)}
.sn-row{display:flex;gap:8px;align-items:center;margin:10px 0;min-width:0}
.sn-book-workspace{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1;min-height:0;min-width:0;gap:18px}
.sn-directory{min-width:0;min-height:0;max-height:none;overflow:hidden;flex:1}
.sn-directory[open]{display:flex;flex-direction:column}
.sn-directory>summary{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;list-style:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.sn-directory>summary::-webkit-details-marker{display:none}
.sn-directory>summary>svg{margin-left:auto;flex-shrink:0;transition:transform .15s}.sn-directory[open]>summary>svg{transform:rotate(180deg)}
.sn-directory-selection{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.sn-directory-body{display:flex;flex-direction:column;flex:1;gap:8px;min-height:0;overflow:hidden}
.sn-directory .sn-modes{flex-wrap:nowrap;gap:4px}.sn-directory .sn-modes>button{flex:1;min-width:0;font-size:12px}
.sn-search{position:relative;flex-shrink:0}.sn-search>svg{position:absolute;left:10px;top:9px;z-index:1;color:var(--dsw-alias-label-tertiary);pointer-events:none}.sn-search input{padding-left:32px!important}
.sn-directory-filters{display:grid;gap:6px;grid-template-columns:repeat(2,minmax(0,1fr));flex-shrink:0}.sn-directory-filters .sn-select{height:30px;font-size:12px}.sn-directory-filters select{font-size:12px}
.sn-directory-status{display:flex;justify-content:space-between;align-items:center;gap:6px;min-height:18px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-shrink:0}.sn-directory-status button{font-size:11px;height:22px;padding:0 6px}
.sn-chapters{min-height:28px;overflow:auto;overscroll-behavior:contain;flex:1}
.sn-chapters button{display:flex;justify-content:flex-start;gap:10px;text-align:left;width:100%;height:auto;min-height:38px;padding:8px 9px;border-radius:7px;align-items:baseline;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.sn-chapters button[aria-current=true]{background:var(--dsw-alias-interactive-bg-active);font-weight:600;box-shadow:inset 2px 0 var(--dsw-alias-brand-primary)}
.sn-number{flex:0 0 20px;font-size:10px;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}
.sn-document-label{min-width:0;display:block}.sn-kind-label{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.sn-document-link{display:block;font-size:10px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.sn-pagination{display:flex;gap:10px;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-shrink:0}.sn-pagination button{width:24px;height:24px;padding:0}
.sn-directory-body>.sn-row{margin:0;padding-top:4px;flex-shrink:0}
.sn-document{container:sn-content / inline-size;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 2px;scrollbar-gutter:stable}.sn-document[data-view=writing]{overflow:hidden}.sn-document>[role=tabpanel]{flex:1;min-height:0}.sn-document>[role=tabpanel]:not(.sn-writing-panel){overflow:auto;padding-bottom:12px}
.sn-document-header{margin:4px 0 10px;flex-shrink:0}.sn-document-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;overflow-wrap:anywhere}
.sn-title-row{display:flex;align-items:center;gap:8px;min-width:0}.sn-title-input{flex:1;min-width:0;border:0!important;background:transparent!important;border-radius:4px!important;height:auto!important}.sn-title-input input{padding:4px 0!important;font-size:20px!important;font-weight:600;line-height:28px!important;letter-spacing:-.3px}.sn-title-input:focus-within{box-shadow:0 1px var(--dsw-alias-brand-primary)}
.sn-modes{display:flex;flex-wrap:wrap;gap:4px}.sn-modes button[aria-pressed=true],.sn-modes button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.sn-work-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));flex-shrink:0;gap:4px;border-top:0.5px solid var(--dsw-alias-border-l2);margin:0;padding:7px 0 0;background:var(--dsw-alias-bg-layer-1)}
.sn-work-tabs button{min-width:0;border-radius:8px;height:34px;padding:4px 2px;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent}
.sn-work-tabs button[aria-selected=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.sn-editor-toolbar{margin:0;gap:6px;flex-wrap:wrap;flex-shrink:0}.sn-editor-toolbar>button:first-child{font-size:11px;padding:3px 8px;height:28px}.sn-editor-toolbar [role=status]{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:normal;line-height:16px;text-align:right;overflow-wrap:anywhere}.sn-editor-toolbar [data-dirty=true]{color:var(--dsw-alias-label-secondary)}
.sn-books textarea,.sn-preview{width:100%;height:280px;min-height:140px;max-height:70vh;overflow:auto;resize:vertical;font:inherit;line-height:1.85;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:12px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.sn-books textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sn-writing-panel{display:flex;flex-direction:column;gap:8px}.sn-books .sn-editor,.sn-books .sn-preview{flex:1;height:0;min-height:120px;max-height:none;font-size:15px;line-height:1.95;padding:12px 4px 28px;border:0;border-radius:0;margin:0;background:transparent;resize:none}.sn-books .sn-editor:focus{box-shadow:inset 0 -1px var(--dsw-alias-border-l2)}
.sn-books textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.sn-editor-footer{display:flex;flex-shrink:0;justify-content:space-between;gap:8px;font-size:10px;color:var(--dsw-alias-label-tertiary);padding:4px 0 8px}
.sn-notice{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}.sn-alert{color:var(--dsw-alias-state-warn-primary)}
.sn-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px 20px;color:var(--dsw-alias-label-secondary);gap:8px;flex:1}.sn-empty-state>svg{width:28px;height:28px;margin-bottom:8px;color:var(--dsw-alias-label-tertiary)}.sn-empty-state h3{color:var(--dsw-alias-label-primary);margin:0}.sn-empty-state p{font-size:12px;max-width:290px;margin:0}
.sn-recovery-actions,.sn-proposals .sn-row,.sn-reviews .sn-row,.sn-facts .sn-row,.sn-history .sn-row,.sn-material-creator .sn-row{flex-wrap:wrap}
.sn-setup{border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:4px;margin-top:12px}
.sn-books summary,.sn-setup summary{cursor:pointer;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:6px 0}
.sn-setup p{font-size:12px}.sn-setup button{margin:4px 6px 4px 0}
.sn-storage{margin-top:4px}.sn-storage>summary{font-size:11px;padding:3px 0;color:var(--dsw-alias-label-tertiary)}.sn-storage .sn-path{font-size:11px;overflow-wrap:anywhere;padding:8px 10px;background:var(--dsw-alias-bg-module-platform);border-radius:8px}.sn-draft-recovery{margin-top:8px}.sn-draft-item{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);font-size:11px}.sn-draft-item>span{flex:1;overflow-wrap:anywhere}.sn-draft-preview>button{margin:4px 8px 4px 0}.sn-editor-toolbar [role=status]{font-size:11px;min-width:0;overflow-wrap:anywhere}
.sn-transfer{margin-top:4px}.sn-transfer>summary{font-size:11px;padding:3px 0;color:var(--dsw-alias-label-tertiary)}
.sn-proposals,.sn-reviews,.sn-facts,.sn-voices,.sn-history{margin-top:12px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.sn-proposals{border-top:0;margin-top:0;padding-top:0}.sn-proposals>h3{font-size:14px}.sn-proposals>.sn-notice{margin:0 0 12px;font-size:11px}
.sn-document-options{margin-top:8px}.sn-document-options>summary{font-size:11px;color:var(--dsw-alias-label-tertiary)}.sn-history{margin-top:4px;padding-top:4px;border:0}.sn-history summary{font-size:11px}
.sn-limits{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.sn-review-dimensions{display:flex;gap:10px;flex-wrap:wrap;font-size:12px}
.sn-review-issue,.sn-fact,.sn-voice{padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.sn-review-issue blockquote,.sn-facts blockquote,.sn-voice blockquote{margin:8px 0;padding:10px 12px;background:var(--dsw-alias-bg-module-platform);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.sn-fact-settings{margin:12px 0}.sn-fact-settings label,.sn-voices>label{display:flex;gap:8px;align-items:center}
.sn-material-list{max-height:220px;overflow:auto}.sn-material-list label{display:flex;align-items:baseline;gap:8px;margin:8px 0;overflow-wrap:anywhere;font-size:12px;line-height:20px}
.sn-material-creator{margin:0 0 8px}.sn-material-creator>summary{display:flex;align-items:center;gap:6px;list-style:none;color:var(--dsw-alias-label-secondary);font-size:12px;width:fit-content;padding:4px 0}.sn-material-creator>summary::-webkit-details-marker{display:none}.sn-material-creator>summary:hover{color:var(--dsw-alias-label-primary)}
.sn-material-creator[open]{padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);margin-bottom:16px}.sn-material-creator[open]>summary{font-weight:600;color:var(--dsw-alias-label-primary)}
.sn-material-creator .sn-instruction{height:100px;min-height:72px;margin:0}.sn-material-creator .sn-notice{font-size:11px}
.sn-history details+details{margin-top:4px}
.sn-generation{margin:0 0 14px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px}.sn-generation>summary{display:flex;align-items:center;gap:8px;padding:10px 0;font-weight:500}.sn-generation[open]{padding-bottom:2px}.sn-generation details>summary{font-size:11px}
.sn-candidate-status{justify-content:space-between;flex-wrap:wrap;margin:12px 0 8px}.sn-candidate-status [role=status]{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.sn-proposals .sn-instruction,.sn-proposals .sn-materials{height:100px;min-height:72px;margin:0}.sn-proposals .sn-materials{height:140px}
.sn-source-count{font-size:10px;margin-left:6px;border-radius:4px;padding:1px 5px;background:var(--dsw-alias-interactive-bg-active)}
.sn-candidate,.sn-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:440px;min-height:80px;font:inherit;font-size:14px;line-height:1.95;padding:18px;margin:10px 0;background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px}
.sn-diff{display:grid;gap:10px;grid-template-columns:minmax(0,1fr)}.sn-diff h4{font-size:11px;font-weight:500;margin:8px 0 0;color:var(--dsw-alias-label-secondary)}
.sn-proposals .sn-row span{overflow-wrap:anywhere}.sn-return-content{margin:12px 0;color:var(--dsw-alias-label-secondary)}
.sn-import-preview{max-height:180px;overflow:auto;padding-left:24px}.sn-import-preview li{overflow-wrap:anywhere}

.sn-project-heading{display:flex;align-items:center;gap:8px;flex-shrink:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);padding:0 0 7px;margin:0 0 10px}
.sn-project-title{display:flex;justify-content:flex-start;gap:8px;flex:1;min-width:0;height:28px;padding:2px 4px!important;text-align:left;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.sn-project-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sn-project-title>svg{flex-shrink:0}
.sn-project-save{font-size:10px;max-width:50%;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary)}.sn-books>.sn-alert{flex-shrink:0;font-size:11px;line-height:18px}.sn-books>.sn-alert button{margin:4px 6px 0 0;font-size:11px}
.sn-workspace-body{position:relative;display:flex;flex:1;min-height:0;min-width:0;overflow:hidden}
.sn-workspace-panel{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--dsw-alias-bg-layer-1)}
.sn-panel-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:38px;margin:0 0 10px;flex-shrink:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);padding-bottom:8px}.sn-panel-heading h3{font-size:14px;margin:0}.sn-panel-heading h3:focus{outline:none}
.sn-panel-body{flex:1;min-height:0;min-width:0;overflow:auto;padding:0 2px 16px;overscroll-behavior:contain}
#sn-panel-directory .sn-panel-body{display:flex;flex-direction:column;overflow:hidden;padding-bottom:8px}.sn-directory>summary{display:none}
.sn-inline-panel{position:static;border-right:0.5px solid var(--dsw-alias-border-l2);padding-right:14px}.sn-inline-panel .sn-panel-heading{min-height:28px;border:0;padding:0;margin:4px 0 10px}.sn-inline-panel .sn-panel-heading h3{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.sn-books[data-compact=false] .sn-workspace-panel:not(.sn-inline-panel){left:auto;width:min(420px,100%);border-left:0.5px solid var(--dsw-alias-border-l2);padding-left:16px;box-shadow:-10px 0 24px rgba(0,0,0,.05)}
.sn-more-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding-top:12px;margin-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2)}.sn-document-management{margin-top:18px}.sn-document-management>h3{font-size:13px;overflow-wrap:anywhere}
.sn-tool-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;margin-bottom:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.sn-workspace-panel .sn-material-creator[open]{padding:0;border:0;margin:0;background:transparent}.sn-workspace-panel .sn-material-creator>summary{display:none}
.sn-reference-panel{display:flex;flex-direction:column;gap:10px;min-width:0}.sn-reference-back{align-self:flex-start}.sn-reference-panel h3{margin:0;font-size:17px;overflow-wrap:anywhere}.sn-reference-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}.sn-reference-meta>span{color:var(--dsw-alias-label-secondary)}
.sn-reference-list{display:flex;flex-direction:column;gap:4px}.sn-reference-list button{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;height:auto;padding:10px;overflow-wrap:anywhere}.sn-reference-list small{font-size:10px;color:var(--dsw-alias-label-tertiary);font-weight:400}.sn-reference-text{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;line-height:1.95;margin:0 0 12px;padding:8px 0}
@container sn-pane (max-width:350px){.sn-directory-selection{max-width:150px}.sn-title-input input{font-size:19px!important}.sn-editor-footer>span:last-child{display:none}.sn-new-book{flex-wrap:wrap}.sn-new-book>.sn-input{flex-basis:100%}}
@container sn-pane (min-width:760px){.sn-book-workspace{grid-template-columns:228px minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:20px}.sn-directory{max-height:none;border:0}.sn-directory-body{flex:1}.sn-directory-selection{display:none}.sn-directory-filters{grid-template-columns:minmax(0,1fr)}.sn-document{padding-right:8px}.sn-document-header{margin-top:6px}.sn-title-input input{font-size:25px!important}.sn-books .sn-editor,.sn-books .sn-preview{padding:16px 12px 36px;font-size:16px;max-width:840px;align-self:center}.sn-library-heading{margin-bottom:6px}.sn-book-picker{max-width:380px}}
@container sn-content (min-width:500px){.sn-material-basics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}}
@container sn-content (min-width:560px){.sn-diff{grid-template-columns:repeat(2,minmax(0,1fr))}}

.sn-books .sn-editor, .sn-books .sn-preview { max-width: var(--sn-writing-width, 72ch); font-size: var(--sn-writing-font, 18px); line-height: var(--sn-writing-spacing, 1.9); width: min(100%, var(--sn-writing-width, 72ch)); margin-inline: auto; }
.sn-editor-footer { align-items: center; padding: 0; min-height: 28px; }
.sn-editor-footer > .sn-row { flex-wrap: nowrap; justify-content: flex-end; gap: 2px; margin: 0; }
.sn-editor-footer > .sn-row > span { display:none; }
.sn-editor-footer > .sn-row > button { height:28px; min-height:28px; font-size:11px; white-space:nowrap; padding:2px 6px; }
.sn-story-state .sn-modes { display:flex; flex-wrap:wrap; gap:4px; }
.sn-story-evidence blockquote { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0; padding:8px 10px; background:var(--dsw-alias-bg-module-platform); border-radius:8px; }
.sn-story-form .sn-input,.sn-story-form .sn-select { margin:6px 0; }
.sn-story-form { border:0; margin:0; padding:0; min-width:0; }
.sn-story-state .sn-row { flex-wrap:wrap; }
.sn-reference-panel .sn-modes { flex-wrap: wrap; }

.sn-search-results{display:grid;gap:8px;margin:12px 0}.sn-search-results>button{display:flex;flex-direction:column;align-items:stretch;text-align:left;width:100%;min-width:0;height:auto;padding:10px!important;white-space:normal;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px}
.sn-search-result-title{display:flex;flex-wrap:wrap;gap:3px 8px;justify-content:space-between;align-items:baseline;overflow-wrap:anywhere}.sn-search-result-title small{font-size:10px;color:var(--dsw-alias-label-tertiary)}.sn-search-snippet{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin-top:5px;font-size:12px;line-height:1.75;font-weight:400;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:normal}.sn-search-empty{padding:20px 4px;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary)}
.sn-reader-navigation{display:flex;align-items:center;justify-content:space-between;gap:6px}.sn-reader-text{max-height:55vh;min-height:80px;overflow:auto;overscroll-behavior:contain}.sn-reader-text mark{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);outline:1px solid var(--dsw-alias-border-l2);border-radius:2px}.sn-document-reader blockquote{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:8px;background:var(--dsw-alias-bg-module-platform);border-radius:8px;font-size:12px}
.sn-document-references{margin-top:12px}.sn-document-references>summary{font-size:12px;color:var(--dsw-alias-label-secondary)}.sn-document-links h4{font-size:11px;font-weight:500;margin:12px 0 5px;color:var(--dsw-alias-label-secondary)}.sn-link-list{display:flex;flex-wrap:wrap;gap:5px}.sn-link-list button{max-width:100%;height:auto;white-space:normal;text-align:left;overflow-wrap:anywhere}
`
