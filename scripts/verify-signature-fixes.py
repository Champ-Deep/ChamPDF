# Run against a running Vite preview: CHAMPDF_URL=http://127.0.0.1:3296 python scripts/verify-signature-fixes.py
# Non-repo dependencies: pip install playwright PyMuPDF; python -m playwright install chromium
# Set CHAMPDF_EVIDENCE to retain output in a chosen directory; otherwise a fresh temp directory is printed.
import json, os, tempfile
import pymupdf
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
OUT=Path(os.environ['CHAMPDF_EVIDENCE']) if 'CHAMPDF_EVIDENCE' in os.environ else Path(tempfile.mkdtemp(prefix='champdf-evidence-'))
OUT.mkdir(exist_ok=True)
print(f'Evidence: {OUT}')
URL=os.environ.get('CHAMPDF_URL','http://127.0.0.1:3296')

def run():
 fixture=pymupdf.open()
 fixture.new_page(width=612,height=792).insert_text((40,52),'Signature verification fixture',fontsize=16)
 fixture.new_page(width=612,height=792)
 fixture.save(OUT/'fixture.pdf');fixture.close()
 results=[]; errors=[]
 with sync_playwright() as p:
  browser=p.chromium.launch()
  context=browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True)
  page=context.new_page(); page.on('pageerror',lambda e: errors.append(str(e)))
  page.on('console',lambda m: errors.append(m.text) if m.type=='error' else None)
  page.goto(URL+'/'); page.locator('#open-signatures-btn').click()
  expect(page.locator('#signature-library-modal')).to_be_visible()
  page.screenshot(path=str(OUT/'fix-home-signatures.png'))
  page.locator('#tab-create-signature').click(); page.locator('#sig-name-input').fill('Review Signature')
  page.locator('#signature-library-use').click()
  expect(page.locator('.signature-card')).to_have_count(1)
  expect(page.locator('#signature-library-modal')).to_be_visible()
  quality=page.locator('.signature-card img').evaluate('''async img=>{await img.decode(); const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let ink=0,transparent=0;for(let i=3;i<d.length;i+=4){if(d[i])ink++;else transparent++;}return {width:c.width,height:c.height,ink,transparent,corner:d[3]}}''')
  assert quality['width']==1800 and quality['height']==600 and quality['ink']>0 and quality['corner']==0
  results.append({'check':'home, save, transparent 3x PNG','quality':quality})
  page.keyboard.press('Escape'); expect(page.locator('#signature-library-modal')).not_to_be_visible()
  page.reload(); page.locator('#open-signatures-btn').click(); expect(page.locator('.signature-card')).to_have_count(1)
  page.screenshot(path=str(OUT/'fix-saved-signatures.png'))
  page.goto(URL+'/sign-pdf.html'); page.locator('#file-input').set_input_files(str(OUT/'fixture.pdf'))
  expect(page.locator('.signature-drag-item')).to_have_count(1)
  page.locator('.signature-drag-item').click(); expect(page.locator('.annotation-box img')).to_have_count(1)
  page.locator('[data-type="text"].tool-btn').click()
  text=page.locator('.annotation-box textarea');text.fill('Approved')
  size=page.locator('#text-font-size');expect(size).to_be_enabled();size.fill('24');size.press('Tab')
  expect(text).to_have_css('font-size','24px')
  # Keep annotations distinct so the evidence shows both, rather than a synthetic overlap.
  box=page.locator('.annotation-box').last.bounding_box()
  page.mouse.move(box['x']+2,box['y']+2);page.mouse.down();page.mouse.move(box['x']+2,box['y']+82,steps=10);page.mouse.up()
  text.focus();expect(size).to_have_value('24')
  assert text.evaluate('(el)=>el.clientHeight >= parseFloat(getComputedStyle(el).lineHeight) + 8'), '24pt text is vertically clipped'
  page.screenshot(path=str(OUT/'fix-text-size.png'),full_page=True)
  page.locator('#zoom-in').click();expect(page.locator('#zoom-level')).to_have_text('125%')
  expect(text).to_have_css('font-size','30px')
  page.locator('#next-page').click();expect(page.locator('#page-indicator')).to_have_text('Page 2 of 2')
  page.locator('#prev-page').click();expect(page.locator('#page-indicator')).to_have_text('Page 1 of 2')
  expect(text).to_have_value('Approved');expect(text).to_have_css('font-size','30px')
  text.focus();size.fill('500');size.press('Tab');expect(size).to_have_value('72')
  size.fill('1');size.press('Tab');expect(size).to_have_value('6')
  size.fill('');size.press('Tab');expect(size).to_have_value('6')
  size.fill('24');size.press('Tab')
  with page.expect_download() as download:
   page.locator('#save-signed-pdf').click()
  download.value.save_as(str(OUT/'signed-fixture.pdf'))
  pdf=pymupdf.open(OUT/'signed-fixture.pdf')
  spans=[s for b in pdf[0].get_text('dict')['blocks'] if 'lines' in b for line in b['lines'] for s in line['spans']]
  assert any(s['text']=='Approved' and s['size']==24 for s in spans),spans
  assert pdf[0].get_images(), 'Signature image missing from PDF'
  pdf[0].get_pixmap().save(OUT/'signed-pdf-render.png');pdf.close()
  results.append({'check':'reuse after reload, placement, 24pt, zoom, pages, size bounds, PDF download','passed':True})
  for width,height in [(375,812),(768,1024),(1440,1000)]:
   page.set_viewport_size({'width':width,'height':height});page.goto(URL+'/');
   if width<768:
    # The existing mobile navigation exposes the same library action.
    page.locator('#mobile-menu-button').click()
    page.locator('#open-signatures-btn-mobile').click()
   else:page.locator('#open-signatures-btn').click()
   expect(page.locator('#signature-library-modal')).to_be_visible()
   for state in ['saved','create']:
    if state=='create':page.locator('#tab-create-signature').click()
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT/f'library-{state}-{width}.png'))
    bounds=page.locator('#signature-library-modal button:visible, #signature-library-modal input:visible').evaluate_all('(els)=>els.map(el=>({id:el.id,w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height,right:el.getBoundingClientRect().right})).filter(r=>r.w<44||r.h<44||r.right>innerWidth+1)')
    assert not bounds,bounds
    if state=='create':
     preview=page.locator('#sig-preview-canvas');preview.scroll_into_view_if_needed()
     reachable=preview.evaluate('(el)=>{const r=el.getBoundingClientRect();const footer=document.getElementById("signature-library-use").getBoundingClientRect();return r.bottom<=footer.top && r.top>=0}')
     assert reachable,'Preview cannot be scrolled clear of footer'
   page.goto(URL+'/sign-pdf.html');page.locator('#file-input').set_input_files(str(OUT/'fixture.pdf'))
   page.locator('[data-type="text"].tool-btn').click();page.locator('.annotation-box textarea').fill('Approved')
   size=page.locator('#text-font-size');size.fill('18');size.press('Tab')
   page.wait_for_timeout(400)
   page.evaluate('document.getElementById("pdf-scroll-container").scrollLeft=0; const toolbar=document.getElementById("signer-toolbar"); const size=document.getElementById("text-font-size");toolbar.scrollTop+=size.getBoundingClientRect().top-toolbar.getBoundingClientRect().top-50')
   assert page.evaluate('document.getElementById("pdf-page-container").getBoundingClientRect().left >= document.getElementById("pdf-scroll-container").getBoundingClientRect().left'), 'PDF left edge is unreachable'
   page.locator('#signature-editor').screenshot(path=str(OUT/f'editor-{width}.png'))
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Overflow at {width}'
   results.append({'check':f'library saved/create and editor size control at {width}','passed':True})
  page.set_viewport_size({'width':1440,'height':1000})
  page.locator('#add-new-signature').click();page.locator('#tab-create-signature').click()
  page.locator('#sig-name-input').fill('Second Signature');page.locator('#signature-library-use').click()
  expect(page.locator('.signature-card')).to_have_count(2)
  page.locator('.select-signature-btn').last.focus();page.keyboard.press('Enter')
  page.locator('#signature-library-use').click()
  expect(page.locator('.annotation-box img')).to_have_count(1)
  expect(page.locator('.signature-drag-item')).to_have_count(2)
  page.goto(URL+'/create-signature.html');page.locator('#signature-name').fill('Third Signature')
  page.once('dialog',lambda dialog: dialog.accept());page.locator('#save-to-library-btn').click()
  page.wait_for_function("JSON.parse(localStorage.getItem('champdf_signatures') || '[]').length === 3")
  page.goto(URL+'/sign-pdf.html');page.locator('#file-input').set_input_files(str(OUT/'fixture.pdf'))
  expect(page.locator('.signature-drag-item')).to_have_count(3)
  results.append({'check':'create inside sign flow, keyboard selection, toolbar refresh, standalone creation and next-flow reuse','passed':True})
  assert not errors,errors
  (OUT/'browser-results.json').write_text(json.dumps({'results':results,'console_errors':errors},indent=2));print(json.dumps(results,indent=2))
  browser.close()
if __name__=='__main__':run()
