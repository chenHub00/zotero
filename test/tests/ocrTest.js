describe("Zotero.OCR", function () {
	var win;
	
	before(async function () {
		win = await loadZoteroPane();
	});
	
	after(function () {
		win.close();
	});
	
	afterEach(function () {
		Zotero.Prefs.clear('ocr.auto');
		sinon.restore();
	});
	
	describe("#canOCR()", function () {
		it("should allow PDF attachments", async function () {
			let item = await importFileAttachment('test.pdf');
			assert.isTrue(Zotero.OCR.canOCR(item));
		});
		
		it("should not allow non-PDF attachments", async function () {
			let item = await importFileAttachment('test.html');
			assert.isFalse(Zotero.OCR.canOCR(item));
		});
		
		it("should not allow regular items", async function () {
			let item = await createDataObject('item');
			assert.isFalse(Zotero.OCR.canOCR(item));
		});
	});
	
	describe("Fulltext integration", function () {
		// empty.pdf has no extractable text
		it("should index OCR text for a PDF without text when forced", async function () {
			sinon.stub(Zotero.OCR, 'isAvailable').resolves(true);
			let stub = sinon.stub(Zotero.OCR, 'recognizeFile')
				.resolves({ text: 'scannedtestword', pages: 1 });
			let item = await importFileAttachment('empty.pdf');
			let path = await item.getFilePathAsync();
			
			assert.isTrue(await Zotero.Fulltext.indexPDF(path, item.id, true, { forceOCR: true }));
			assert.isTrue(stub.calledOnce);
			let cacheFile = Zotero.Fulltext.getItemCacheFile(item).path;
			assert.equal(await Zotero.File.getContentsAsync(cacheFile), 'scannedtestword');
		});
		
		it("should not run OCR if neither forced nor enabled by pref", async function () {
			sinon.stub(Zotero.OCR, 'isAvailable').resolves(true);
			let stub = sinon.stub(Zotero.OCR, 'recognizeFile');
			let item = await importFileAttachment('empty.pdf');
			let path = await item.getFilePathAsync();
			
			assert.isFalse(await Zotero.Fulltext.indexPDF(path, item.id, true));
			assert.isFalse(stub.called);
		});
		
		it("should run OCR automatically if ocr.auto is enabled", async function () {
			Zotero.Prefs.set('ocr.auto', true);
			sinon.stub(Zotero.OCR, 'isAvailable').resolves(true);
			let stub = sinon.stub(Zotero.OCR, 'recognizeFile')
				.resolves({ text: 'autoocrword', pages: 1 });
			let item = await importFileAttachment('empty.pdf');
			let path = await item.getFilePathAsync();
			
			assert.isTrue(await Zotero.Fulltext.indexPDF(path, item.id, true));
			assert.isTrue(stub.calledOnce);
		});
		
		it("should return false if OCR fails", async function () {
			sinon.stub(Zotero.OCR, 'isAvailable').resolves(true);
			sinon.stub(Zotero.OCR, 'recognizeFile').rejects(new Error("failed"));
			sinon.stub(Zotero, 'logError');
			let item = await importFileAttachment('empty.pdf');
			let path = await item.getFilePathAsync();
			
			assert.isFalse(await Zotero.Fulltext.indexPDF(path, item.id, true, { forceOCR: true }));
		});
	});
});
