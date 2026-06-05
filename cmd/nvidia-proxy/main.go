package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"nvidia-proxy/internal/bridge"
	"nvidia-proxy/internal/server"
	"nvidia-proxy/internal/utils"
)

func main() {
	port := utils.EnvOr("PORT", "4874")
	tabID := utils.EnvOr("TAB_ID", "196650910")

	b := bridge.New(tabID)
	h := server.New(b)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"service":"nvidia-proxy","status":"running"}`))
			return
		}
		http.NotFound(w, r)
	})
	h.Register(mux)

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%s", port),
		Handler: mux,
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("shutting down...")
		srv.Close()
	}()

	log.Printf("nvidia-proxy listening on :%s (tab: %s)", port, tabID)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
