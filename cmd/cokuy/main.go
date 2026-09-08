// Command cokuy is the single deployable binary: Telegram long polling in,
// bounded agent turn, SQLite persistence, Telegram reply out.
//
// Failure posture: a failed turn fails recoverably (user input is already
// durable) and never duplicates side effects (update_id claim first).
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"cokuy/internal/config"
	"cokuy/internal/inference"
	"cokuy/internal/metrics"
	"cokuy/internal/runtime"
	"cokuy/internal/storage"
	"cokuy/internal/transport"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	db, err := storage.Open(cfg.SQLitePath)
	if err != nil {
		return err
	}
	defer db.Close()

	llm := inference.NewOpenAICompatible(
		cfg.LLMBaseURL, cfg.LLMAPIKey, cfg.LLMModel,
		cfg.LLMExtraHeaders, cfg.LLMTimeoutSecs,
	)
	bot, err := transport.New(cfg.TelegramBotToken)
	if err != nil {
		return err
	}
	agent := runtime.New(cfg, db, llm, bot, log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Dashboard metrics: loopback only, bearer token, off when the token
	// is empty. Never bind a public address here.
	if cfg.MetricsToken != "" {
		srv := &http.Server{Addr: cfg.MetricsAddr, Handler: metrics.New(db, cfg.MetricsToken, cfg.LLMPriceInPerM, cfg.LLMPriceOutPerM).Handler()}
		go func() {
			log.Info("metrics listening", "addr", cfg.MetricsAddr)
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Error("metrics server failed", "err", err)
			}
		}()
		defer func() {
			shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(shutCtx)
		}()
	} else {
		log.Info("metrics disabled (METRICS_TOKEN empty)")
	}

	log.Info("cokuy started, polling telegram")
	updates := bot.Updates()
	defer bot.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("shutdown")
			return nil
		case u, ok := <-updates:
			if !ok {
				log.Info("updates channel closed")
				return nil
			}
			if u.Message == nil || u.Message.From == nil {
				continue
			}
			// One bounded turn per update, sequential: preserves reply
			// order and keeps the tiny VPS footprint flat.
			agent.HandleUpdate(ctx, int64(u.UpdateID), u.Message.From.ID, u.Message.Chat.ID, u.Message.Text)
		}
	}
}
