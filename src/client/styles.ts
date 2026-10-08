/** Plugin geometry uses DSH theme tokens; shared controls keep their own styling. */
export const styles = `
.super-novel-setup{container:sn-pane / inline-size;display:flex;flex-direction:column;gap:8px;padding:16px;height:100%;overflow:hidden;box-sizing:border-box;min-width:0;min-height:0;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.super-novel-setup *{box-sizing:border-box}
.super-novel-setup h2{font-size:16px;line-height:24px;margin:0;font-weight:600}
.super-novel-setup h3{font-size:14px;line-height:22px;margin:0 0 8px;font-weight:600}
.super-novel-setup p{overflow-wrap:anywhere;margin:8px 0}
.super-novel-setup button{font-family:inherit;white-space:normal;max-width:100%;flex-shrink:0}
.super-novel-setup :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sn-input{width:100%;min-width:0}
.sn-row>.sn-input{flex:1}
.sn-select{position:relative;display:flex;align-items:center;width:100%;min-width:0;height:34px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.sn-select:focus-within{border-color:var(--dsw-alias-brand-primary)}
.sn-select select{appearance:none;width:100%;height:100%;min-width:0;padding:0 30px 0 10px;border:0;background:transparent;font:inherit;font-size:13px;line-height:20px;color:inherit;cursor:pointer;text-overflow:ellipsis}
.sn-select>svg{position:absolute;right:10px;pointer-events:none;color:var(--dsw-alias-label-tertiary)}
.super-novel-setup input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);flex:0 0 16px}
.super-novel-setup input[type=file]{width:100%;min-width:0;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.super-novel-setup input[type=file]::file-selector-button{border:0.5px solid var(--dsw-alias-border-l3);border-radius:14px;corner-shape:round;background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);font:inherit;padding:5px 10px;margin-right:8px;cursor:pointer}
.sn-books{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;gap:12px}
.sn-library{flex-shrink:0;max-height:35%;overflow:auto;scrollbar-gutter:stable}
.sn-toolbar{display:flex;align-items:center;gap:8px;min-height:32px}
.sn-toolbar h2{flex:1}
.sn-icon{width:28px!important;height:28px!important;padding:0!important;flex:0 0 28px}
.sn-workspace{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 0 8px}
.sn-field{display:grid;gap:5px;margin:10px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.sn-field .sn-input,.sn-field .sn-select{color:var(--dsw-alias-label-primary)}
.sn-library .sn-field{margin:4px 0}.sn-library .sn-row{margin:6px 0}
.sn-row{display:flex;gap:8px;align-items:center;margin:10px 0;min-width:0}
.sn-book-workspace{display:grid;grid-template-rows:auto minmax(160px,1fr);flex:1;min-height:0;min-width:0;gap:12px}
.sn-directory{min-width:0;min-height:0;max-height:min(360px,40vh);overflow:auto;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform);scrollbar-gutter:stable}
.sn-directory>summary{position:sticky;top:0;padding:10px 12px;cursor:pointer;background:var(--dsw-alias-bg-module-platform);z-index:1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sn-directory-selection{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sn-directory-body{padding:0 10px 10px}
.sn-directory-filters{display:grid;gap:0 8px;grid-template-columns:repeat(2,minmax(0,1fr))}
.sn-directory-status{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.sn-chapters{max-height:160px;overflow:auto;margin-top:8px;overscroll-behavior:contain}
.sn-chapters button{display:flex;justify-content:flex-start;gap:8px;text-align:left;width:100%;height:auto;min-height:36px;padding:7px 8px;border-radius:8px;align-items:baseline;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.sn-chapters button[aria-current=true]{background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.sn-chapters button>span:last-child{min-width:0}
.sn-number{flex:0 0 18px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.sn-document-link{display:block;font-size:11px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.sn-document{container:sn-content / inline-size;min-width:0;min-height:0;overflow:auto;padding-right:4px;scrollbar-gutter:stable;overscroll-behavior:contain}
.sn-document-title{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:16px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.sn-modes{display:flex;flex-wrap:wrap;gap:4px}
.sn-modes button[aria-pressed=true],.sn-modes button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.sn-work-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:0 0 12px;padding:4px;background:var(--dsw-alias-bg-module-platform);border-radius:12px}
.sn-work-tabs button{padding:4px;height:auto;min-height:28px}
.sn-work-tabs button[aria-selected=true]{background:var(--dsw-alias-bg-layer-1);font-weight:600}
.sn-books [hidden]{display:none!important}
.sn-editor-toolbar{justify-content:space-between;flex-wrap:wrap;margin:10px 0 0}
.sn-editor-toolbar [role=status]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.sn-books textarea,.sn-preview{width:100%;height:320px;min-height:200px;max-height:70vh;overflow:auto;resize:vertical;font:inherit;line-height:1.8;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:14px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.sn-books textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sn-notice{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sn-alert{color:var(--dsw-alias-state-warn-primary)}
.sn-recovery-actions,.sn-proposals .sn-row,.sn-reviews .sn-row,.sn-facts .sn-row,.sn-history .sn-row,.sn-material-creator .sn-row{flex-wrap:wrap}
.sn-setup{flex-shrink:0;border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:6px;max-height:20%;overflow:auto}
.sn-setup summary,.sn-transfer summary,.sn-history summary,.sn-proposals summary,.sn-material-creator summary,.sn-reviews summary,.sn-facts summary{cursor:pointer;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.sn-setup p{font-size:12px;line-height:20px}.sn-setup button{margin:4px 6px 4px 0}
.sn-transfer{margin-top:4px;padding-top:4px}
.sn-proposals,.sn-reviews,.sn-facts,.sn-voices,.sn-history{border-top:0.5px solid var(--dsw-alias-border-l2);margin-top:16px;padding-top:12px}
.sn-proposals{margin-top:8px}
.sn-limits{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.sn-review-dimensions{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;line-height:20px}
.sn-review-issue,.sn-fact,.sn-voice{padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.sn-review-issue blockquote,.sn-facts blockquote,.sn-voice blockquote{margin:8px 0;padding:10px 12px;background:var(--dsw-alias-bg-module-platform);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.sn-fact-settings label,.sn-voices>label{display:flex;gap:8px;align-items:center}
.sn-material-list{max-height:220px;overflow:auto}
.sn-material-list label{display:flex;align-items:baseline;gap:8px;margin:8px 0;overflow-wrap:anywhere;font-size:13px;line-height:20px}
.sn-material-creator{margin:0 0 12px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.sn-material-creator>summary{font-weight:600;color:var(--dsw-alias-label-primary)}
.sn-material-creator .sn-instruction{height:100px;min-height:72px;margin:0}
.sn-material-heading{margin:20px 0 8px!important}
.sn-history details+details{margin-top:8px}
.sn-generation{margin-bottom:12px}.sn-candidate-status{justify-content:space-between;flex-wrap:wrap}
.sn-candidate-status [role=status]{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sn-proposals .sn-instruction,.sn-proposals .sn-materials{height:110px;min-height:72px;margin:0}
.sn-proposals .sn-materials{height:160px}
.sn-candidate,.sn-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:380px;min-height:64px;font:inherit;line-height:1.8;padding:12px;margin:6px 0;background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px}
.sn-diff{display:grid;gap:10px;grid-template-columns:minmax(0,1fr)}
.sn-diff h4{font-size:12px;line-height:20px;font-weight:500;margin:8px 0 0;color:var(--dsw-alias-label-secondary)}
.sn-proposals .sn-row span{overflow-wrap:anywhere}.sn-import-preview{max-height:180px;overflow:auto;padding-left:24px}.sn-import-preview li{overflow-wrap:anywhere}
@container sn-pane (max-width:350px){.sn-directory-filters{grid-template-columns:minmax(0,1fr)}.sn-directory{max-height:42vh}}
@container sn-pane (min-width:760px){.sn-book-workspace{grid-template-columns:260px minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.sn-directory{max-height:none}.sn-chapters{max-height:none;overflow:visible}.sn-directory-filters{grid-template-columns:minmax(0,1fr)}}
@container sn-content (min-width:560px){.sn-diff{grid-template-columns:repeat(2,minmax(0,1fr))}.sn-books textarea,.sn-preview{height:460px}}
`
