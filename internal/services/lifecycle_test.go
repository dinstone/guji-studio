package services

// 关闭闸门状态机测试：不依赖 wails 窗口（win=nil），只验证「放行位」的置位与幂等。
// 钩子拦截 / 事件转发属 wails 桥接行为，真机验证（点红灯 4s 内必退出）。

import (
	"sync"
	"testing"
	"time"
)

func gateOK() bool {
	closeGateMu.Lock()
	defer closeGateMu.Unlock()
	return closeGateOK
}

// TestCloseGateConfirmIdempotent 前端回话 + 看门狗双触发不炸、恒置放行位。
func TestCloseGateConfirmIdempotent(t *testing.T) {
	closeGateReset()
	defer closeGateReset()

	var svc CloseGateService
	svc.ConfirmClose() // 前端 flush 完成回话
	if !gateOK() {
		t.Fatal("ConfirmClose 后应放行")
	}
	forceCloseGate() // 看门狗随后也到点：幂等，不 panic
	forceCloseGate()
}

// TestCloseGateWatchdogForce 看门狗单独触发（前端无响应）也必须置放行位。
func TestCloseGateWatchdogForce(t *testing.T) {
	closeGateReset()
	defer closeGateReset()

	forceCloseGate() // win=nil：只置位，不碰窗口
	if !gateOK() {
		t.Fatal("看门狗触发后应放行")
	}
}

// TestCloseGateTimeoutBound 看门狗时长必须为正（防止误设 0 导致关闭被永久拦截或秒放）。
func TestCloseGateTimeoutBound(t *testing.T) {
	if closeGateTimeout <= 0 || closeGateTimeout > 30*time.Second {
		t.Fatalf("看门狗时长异常: %v", closeGateTimeout)
	}
}

// TestCloseGateConcurrent 并发触发不放（数据竞态由 -race 抓）。
func TestCloseGateConcurrent(t *testing.T) {
	closeGateReset()
	defer closeGateReset()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			forceCloseGate()
		}()
	}
	wg.Wait()
	if !gateOK() {
		t.Fatal("并发触发后应放行")
	}
}
