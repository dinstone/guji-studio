//go:build darwin

package services

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// wails 的 WebviewWindow（NSWindow 子类）持有 webView 属性（见 wails 源码
// webview_window_darwin.h 的 WailsWebviewWindow 协议）。此处只声明 selector，
// 运行时由动态绑定命中 wails 的实现，无需其头文件。
@interface NSWindow (GujiWailsWebView)
- (id)webView;
@end

// 主线程执行：静默打印出 PDF。纸张 = 叶子物理尺寸（mm→pt），边距 0，
// pagination clip（不缩放不重排，每叶恰好一页），jobDisposition = NSPrintSaveJob
// 直接落文件，全程无对话框。注意 [printOperation runOperation] 在 WKWebView 下
// 无效（wails 源码同款注释），必须 runOperationModalForWindow 走 modal session。
static char *exportPDFMain(WKWebView *wv, const char *path, double wMM, double hMM) {
	NSPrintInfo *pinfo = [[NSPrintInfo alloc] init];
	// 纸张宽>高（横宽叶面）时不能直接把 w×h 塞给 paperSize——AppKit 仍按纵向纸处理，
	// 内容被裁。标准做法：paperSize 恒按纵归一（宽=min、高=max），横向时把 orientation
	// 设为 Landscape，AppKit 转置可打印画布，最终页恰好等于叶子物理尺寸。
	double pw = wMM / 25.4 * 72.0, ph = hMM / 25.4 * 72.0;
	if (pw > ph) {
		pinfo.orientation = NSPaperOrientationLandscape;
		pinfo.paperSize = NSMakeSize(ph, pw);
	} else {
		pinfo.orientation = NSPaperOrientationPortrait;
		pinfo.paperSize = NSMakeSize(pw, ph);
	}
	pinfo.topMargin = 0; pinfo.bottomMargin = 0;
	pinfo.leftMargin = 0; pinfo.rightMargin = 0;
	pinfo.horizontalPagination = NSPrintingPaginationModeClip;
	pinfo.verticalPagination = NSPrintingPaginationModeClip;
	[pinfo setHorizontallyCentered:NO];
	[pinfo setVerticallyCentered:NO];
	pinfo.jobDisposition = NSPrintSaveJob;
	[[pinfo dictionary] setObject:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]]
	                       forKey:NSPrintJobSavingURL];

	NSPrintOperation *op = [wv printOperationWithPrintInfo:pinfo];
	op.showsPrintPanel = NO;
	op.showsProgressPanel = NO;
	op.view.frame = wv.bounds;
	[op runOperationModalForWindow:wv.window delegate:nil didRunSelector:NULL contextInfo:NULL];
	return NULL;
}

static char *windowExportPDF(void *window, const char *path, double wMM, double hMM) {
	NSWindow *nsWindow = (NSWindow *)window;
	if (!nsWindow) return strdup("窗口不存在");
	WKWebView *wv = (WKWebView *)[nsWindow valueForKey:@"webView"];
	if (!wv || ![wv isKindOfClass:[WKWebView class]]) return strdup("未找到 WKWebView");
	__block char *err = NULL;
	void (^block)(void) = ^{ err = exportPDFMain(wv, path, wMM, hMM); };
	if ([NSThread isMainThread]) {
		block();
	} else {
		dispatch_sync(dispatch_get_main_queue(), block);
	}
	return err;
}
*/
import "C"

import (
	"fmt"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// exportPDFNative：静默矢量导出。打印内容 = 前端 #print-root（逐叶 SVG，
// document 上下文系统字体直接解析），纸张 wMM×hMM = 叶子物理尺寸。
// 导出期间主线程跑打印 modal（无面板），数十叶约数秒。
func (s *PrintService) exportPDFNative(path string, wMM, hMM float64) error {
	win := application.Get().Window.Current()
	ww, ok := win.(*application.WebviewWindow)
	if !ok || ww == nil {
		return fmt.Errorf("未找到可打印窗口")
	}
	cs := C.CString(path)
	defer C.free(unsafe.Pointer(cs))
	cerr := C.windowExportPDF(unsafe.Pointer(ww.NativeWindow()), cs, C.double(wMM), C.double(hMM))
	if cerr != nil {
		defer C.free(unsafe.Pointer(cerr))
		return fmt.Errorf("%s", C.GoString(cerr))
	}
	return nil
}
