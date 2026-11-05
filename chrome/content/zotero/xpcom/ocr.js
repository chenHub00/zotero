/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2025 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     https://www.zotero.org

    This file is part of Zotero.

    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.

    ***** END LICENSE BLOCK *****
*/

/**
 * OCR for scanned PDFs, using an external OCRmyPDF installation
 *
 * The recognized text is stored only in the full-text cache file and index. The PDF itself is
 * never modified.
 */
Zotero.OCR = new function () {
	const BINARY_NAME = 'ocrmypdf';
	const DEFAULT_LANGUAGES = 'eng';

	let _queue = [];
	let _queueProcessing = false;
	let _processingItemID = null;
	let _currentProc = null;
	let _binaryPath;

	let _progressQueue = Zotero.ProgressQueues.create({
		id: 'ocr',
		title: 'ocr.progress.title',
		columns: [
			'recognizePDF.attachmentName.label',
			'ocr.progress.status'
		]
	});

	Zotero.Prefs.registerObserver('ocr.path', () => _binaryPath = undefined);
	
	_progressQueue.addListener('cancel', function () {
		_queue = [];
		if (_currentProc) {
			_currentProc.kill();
		}
	});


	/**
	 * Find the OCRmyPDF executable, using the `ocr.path` pref if set and otherwise searching PATH
	 *
	 * @return {Promise<String|false>}
	 */
	this.getBinaryPath = async function () {
		if (_binaryPath !== undefined) {
			return _binaryPath;
		}
		let customPath = Zotero.Prefs.get('ocr.path');
		if (customPath) {
			_binaryPath = (await IOUtils.exists(customPath)) ? customPath : false;
			return _binaryPath;
		}
		try {
			_binaryPath = await Subprocess.pathSearch(BINARY_NAME);
		}
		catch (e) {
			_binaryPath = false;
		}
		return _binaryPath;
	};


	this.isAvailable = async function () {
		return !!(await this.getBinaryPath());
	};


	/**
	 * Forget the cached executable location (e.g., after the `ocr.path` pref changes)
	 */
	this.resetBinaryPath = function () {
		_binaryPath = undefined;
	};


	/**
	 * @param {Zotero.Item} item
	 * @return {Boolean} - Whether the item is a PDF attachment that OCR can be run on
	 */
	this.canOCR = function (item) {
		return item.isFileAttachment()
			&& item.isPDFAttachment()
			&& item.attachmentLinkMode != Zotero.Attachments.LINK_MODE_LINKED_URL;
	};


	/**
	 * Run OCR on a PDF and return the recognized text
	 *
	 * Pages that already contain text are left alone by OCRmyPDF.
	 *
	 * @param {String} filePath
	 * @param {Object} [options]
	 * @param {Number} [options.maxPages] - Only process this many pages from the start
	 * @return {Promise<{ text: String, pages: Number }>} - Empty text if nothing was recognized
	 */
	this.recognizeFile = async function (filePath, { maxPages } = {}) {
		let binary = await this.getBinaryPath();
		if (!binary) {
			throw new Error("OCRmyPDF not found");
		}

		let tmpDir = PathUtils.join(
			Zotero.getTempDirectory().path,
			'ocr-' + Zotero.Utilities.randomString(8)
		);
		await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true });
		let sidecarPath = PathUtils.join(tmpDir, 'sidecar.txt');
		// OCRmyPDF requires an output path, but with --output-type none it isn't written
		let outputPath = PathUtils.join(tmpDir, 'out.pdf');

		let args = [
			'--skip-text',
			'--output-type', 'none',
			'--sidecar', sidecarPath,
			'-l', Zotero.Prefs.get('ocr.languages') || DEFAULT_LANGUAGES,
			'--quiet'
		];
		if (maxPages) {
			args.push('--pages', `1-${maxPages}`);
		}
		args.push(filePath, outputPath);

		try {
			Zotero.debug(`Running ${binary} ${args.join(' ')}`);
			let proc = _currentProc = await Subprocess.call({
				command: binary,
				arguments: args,
				stderr: 'pipe'
			});
			let stderr = '';
			let str;
			while ((str = await proc.stderr.readString())) {
				stderr += str;
			}
			let { exitCode } = await proc.wait();
			// 6 == "skip-text" and all pages already have text
			if (exitCode && exitCode != 6) {
				throw new Error(`OCRmyPDF exited with code ${exitCode}: ${stderr.trim()}`);
			}
			if (!(await IOUtils.exists(sidecarPath))) {
				return { text: '', pages: 0 };
			}
			let text = await Zotero.File.getContentsAsync(sidecarPath);
			// Pages are separated by form feeds
			let pages = text.split('\f').filter(x => x.trim()).length;
			return { text: text.replace(/\f/g, '\n').trim(), pages };
		}
		finally {
			_currentProc = null;
			try {
				await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	};


	/**
	 * Run OCR on PDF attachments and reindex them with the recognized text
	 *
	 * @param {Zotero.Item[]} items
	 * @return {Promise}
	 */
	this.ocrItems = async function (items) {
		for (let item of items) {
			if (_processingItemID === item.id
					|| _queue.includes(item.id)
					|| !this.canOCR(item)) {
				continue;
			}
			_queue.unshift(item.id);
			_progressQueue.addRow(item);
		}
		await _processQueue();
	};


	async function _processQueue() {
		if (_queueProcessing) return _queueProcessing.promise;
		_queueProcessing = Zotero.Promise.defer();

		let itemID;
		while ((itemID = _queue.pop())) {
			_processingItemID = itemID;
			_progressQueue.updateRow(
				itemID,
				Zotero.ProgressQueue.ROW_PROCESSING,
				Zotero.getString('general.processing')
			);
			try {
				let item = await Zotero.Items.getAsync(itemID);
				if (!item) {
					throw new Error("Item not found");
				}
				if (!(await Zotero.OCR.isAvailable())) {
					throw new Zotero.Exception.Alert('ocr.notInstalled');
				}
				let path = await item.getFilePathAsync();
				if (!path) {
					throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
				}
				let indexed = await Zotero.Fulltext.indexPDF(path, itemID, true, { forceOCR: true });
				if (!indexed) {
					throw new Zotero.Exception.Alert('ocr.noTextFound');
				}
				_progressQueue.updateRow(
					itemID,
					Zotero.ProgressQueue.ROW_SUCCEEDED,
					Zotero.getString('ocr.complete')
				);
			}
			catch (e) {
				Zotero.logError(e);
				_progressQueue.updateRow(
					itemID,
					Zotero.ProgressQueue.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString('general.error')
				);
			}
		}

		_processingItemID = null;
		_queueProcessing.resolve();
		_queueProcessing = false;
	}
};
