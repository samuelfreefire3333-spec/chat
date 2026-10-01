package main

import (
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode"
)

// ==========================================================================
// Registro de eventos de segurança
// ==========================================================================
// Cada evento vai para o log estruturado (JSON no stdout, que o Render guarda)
// e para uma memória curta consultada pelo painel admin (/admin/seguranca).
//
// NUNCA entram aqui: senha, token, chave privada, conteúdo de mensagem, SDP.
// Os campos são fixos (tipo, uid, ip, alvo, detalhe curto) justamente para
// não haver onde colocar essas coisas por engano.

type EventoDeSeguranca struct {
	Quando  time.Time `json:"quando"`
	Tipo    string    `json:"tipo"`
	UID     string    `json:"uid,omitempty"`
	IP      string    `json:"ip,omitempty"`
	Alvo    string    `json:"alvo,omitempty"`
	Detalhe string    `json:"detalhe,omitempty"`
}

// ResumoDeSeguranca é o que o painel admin recebe.
type ResumoDeSeguranca struct {
	Desde      time.Time           `json:"desde"`
	Contadores map[string]int64    `json:"contadores"`
	Recentes   []EventoDeSeguranca `json:"recentes"`
}

type RegistroDeSeguranca struct {
	mu         sync.Mutex
	eventos    []EventoDeSeguranca
	prox       int
	cheio      bool
	contadores map[string]int64
	ultimo     map[string]time.Time
	desde      time.Time
	agora      func() time.Time
	log        *slog.Logger
}

func NovoRegistroDeSeguranca(capacidade int, logger *slog.Logger) *RegistroDeSeguranca {
	if logger == nil {
		logger = slog.Default()
	}
	return &RegistroDeSeguranca{
		eventos:    make([]EventoDeSeguranca, capacidade),
		contadores: make(map[string]int64),
		ultimo:     make(map[string]time.Time),
		desde:      time.Now(),
		agora:      time.Now,
		log:        logger,
	}
}

// Registrar guarda e loga o evento.
func (r *RegistroDeSeguranca) Registrar(e EventoDeSeguranca) {
	if r == nil {
		return
	}
	e = limparEvento(e)
	r.mu.Lock()
	if e.Quando.IsZero() {
		e.Quando = r.agora()
	}
	r.contadores[e.Tipo]++
	if len(r.eventos) > 0 {
		r.eventos[r.prox] = e
		r.prox = (r.prox + 1) % len(r.eventos)
		if r.prox == 0 {
			r.cheio = true
		}
	}
	r.mu.Unlock()

	r.log.Info("seguranca", "evento", e.Tipo, "uid", e.UID, "ip", e.IP, "alvo", e.Alvo, "detalhe", e.Detalhe)
}

// RegistrarComIntervalo conta sempre, mas só guarda/loga o evento se a mesma
// chave não apareceu no último "intervalo" — um flood não vira um flood de log.
func (r *RegistroDeSeguranca) RegistrarComIntervalo(chave string, intervalo time.Duration, e EventoDeSeguranca) {
	if r == nil {
		return
	}
	r.mu.Lock()
	agora := r.agora()
	if len(r.ultimo) > 50000 {
		r.ultimo = make(map[string]time.Time)
	}
	if ultimo, ok := r.ultimo[chave]; ok && agora.Sub(ultimo) < intervalo {
		r.contadores[e.Tipo]++
		r.mu.Unlock()
		return
	}
	r.ultimo[chave] = agora
	r.mu.Unlock()
	r.Registrar(e)
}

// Resumo devolve os contadores e os eventos mais recentes (o mais novo primeiro).
func (r *RegistroDeSeguranca) Resumo(maximo int) ResumoDeSeguranca {
	r.mu.Lock()
	defer r.mu.Unlock()
	cont := make(map[string]int64, len(r.contadores))
	for k, v := range r.contadores {
		cont[k] = v
	}
	total := r.prox
	if r.cheio {
		total = len(r.eventos)
	}
	if maximo > total {
		maximo = total
	}
	recentes := make([]EventoDeSeguranca, 0, maximo)
	for i := 1; i <= maximo; i++ {
		idx := (r.prox - i + len(r.eventos)) % len(r.eventos)
		recentes = append(recentes, r.eventos[idx])
	}
	return ResumoDeSeguranca{Desde: r.desde, Contadores: cont, Recentes: recentes}
}

func limparEvento(e EventoDeSeguranca) EventoDeSeguranca {
	e.Tipo = textoSeguroParaLog(e.Tipo, 40)
	e.UID = textoSeguroParaLog(e.UID, 128)
	e.IP = textoSeguroParaLog(e.IP, 64)
	e.Alvo = textoSeguroParaLog(e.Alvo, 128)
	e.Detalhe = textoSeguroParaLog(e.Detalhe, 200)
	return e
}

// textoSeguroParaLog corta o tamanho e tira caracteres de controle (quebra de
// linha forjada em log, sequências de terminal).
func textoSeguroParaLog(s string, maximo int) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= maximo {
			b.WriteString("…")
			break
		}
		if unicode.IsControl(r) {
			b.WriteRune('?')
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
