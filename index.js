const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. Conexão com o Firebase
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ 
    credential: admin.credential.cert(serviceAccount) 
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// 2. Guardião de Permissões (Middleware)
const verificarPermissao = (permissaoExigida) => {
    return async (req, res, next) => {
        try {
            const usuarioId = req.headers['x-usuario-id']; 
            if (!usuarioId) return res.status(401).json({ erro: 'ID não enviado no Header.' });

            const docUser = await db.collection('usuarios').doc(usuarioId).get();
            if (!docUser.exists) return res.status(404).json({ erro: 'Usuário não encontrado.' });

            const dados = docUser.data();
            if (dados[permissaoExigida] !== true) {
                return res.status(403).json({ erro: 'Sem permissão.' });
            }
            req.usuario = dados;
            next();
        } catch (erro) {
            res.status(500).json({ erro: 'Erro de comunicação.' });
        }
    };
};

// 3. Rotas do Sistema
app.post('/itens', verificarPermissao('podeCadastrarItens'), async (req, res) => {
    try {
        const { nome, categoria, quantidadeAtual, estoqueMinimo } = req.body;
        const novo = await db.collection('itens').add({
            nome, 
            categoria, 
            quantidadeAtual: Number(quantidadeAtual), 
            estoqueMinimo: Number(estoqueMinimo),
            criadoEm: new Date()
        });
        res.status(201).json({ mensagem: 'Item cadastrado', id: novo.id });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao cadastrar.' });
    }
});

app.put('/itens/:id/baixa', verificarPermissao('podeDarBaixa'), async (req, res) => {
    try {
        const { id } = req.params;
        const { quantidadeRetirada } = req.body;
        
        const itemRef = db.collection('itens').doc(id);
        const doc = await itemRef.get();
        
        if (!doc.exists) return res.status(404).json({ erro: 'Item não encontrado.' });

        const novaQuantidade = doc.data().quantidadeAtual - Number(quantidadeRetirada);
        if (novaQuantidade < 0) return res.status(400).json({ erro: 'Estoque insuficiente.' });

        await itemRef.update({ quantidadeAtual: novaQuantidade });

        let alerta = false;
        if (novaQuantidade <= doc.data().estoqueMinimo) {
            alerta = true;
            console.log(`\n⚠️ ALERTA: O item "${doc.data().nome}" caiu para ${novaQuantidade} unidades!`);
        }

        res.json({ mensagem: 'Baixa concluída', restante: novaQuantidade, alerta });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao dar baixa.' });
    }
});

app.listen(3000, () => console.log('🚀 Servidor rodando certinho na porta 3000'));